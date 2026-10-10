//! Start a process that outlives its caller's job (ADR 0001, "Detach"):
//! `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB`.
//! A job without breakaway rights makes `CreateProcessW` fail with
//! `ERROR_ACCESS_DENIED`; there is no retry without breakaway.

use std::fs::{File, OpenOptions};
use std::io;
use std::mem::{size_of, size_of_val, zeroed};
use std::os::windows::io::{FromRawHandle, OwnedHandle};
use std::ptr::null;

use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, HANDLE_FLAG_INHERIT, SetHandleInformation,
};
use windows_sys::Win32::System::Threading::{
    CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, CREATE_UNICODE_ENVIRONMENT,
    CreateProcessW, DETACHED_PROCESS, EXTENDED_STARTUPINFO_PRESENT,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROCESS_INFORMATION, STARTF_USESHOWWINDOW,
    STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

use super::{AttributeList, check, command_line, environment_block, raw, wide};

/// What to start.
#[derive(Debug)]
pub struct Detached<'a> {
    /// The executable's full path.
    pub program: &'a str,
    pub args: &'a [String],
    pub cwd: &'a str,
    /// The whole environment of the new process.
    pub env: &'a [(String, String)],
    /// A file its stdout and stderr append to; `NUL` when `None`.
    pub output: Option<&'a str>,
    pub desktop: Option<&'a str>,
    pub hidden_windows: bool,
}

fn inheritable(file: File) -> io::Result<File> {
    // SAFETY: the handle is open and owned by `file`.
    check(unsafe { SetHandleInformation(raw(&file), HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) })?;
    Ok(file)
}

/// Start `detached` outside the caller's job, with no console and stdin
/// from `NUL`.
///
/// Returns its PID, or `None` when the caller's job forbids breakaway or
/// the requested hidden desktop cannot be opened.
///
/// # Errors
///
/// When the output file cannot be opened or the process cannot start for
/// another reason.
pub fn spawn_detached(detached: &Detached<'_>) -> io::Result<Option<u32>> {
    spawn_with_desktop(detached, super::desktop::inherit_hidden)
}

fn spawn_with_desktop(
    detached: &Detached<'_>,
    open_hidden: impl FnOnce() -> io::Result<super::desktop::Desktop>,
) -> io::Result<Option<u32>> {
    let stdin = inheritable(File::open("NUL")?)?;
    let output = inheritable(match detached.output {
        Some(path) => OpenOptions::new().append(true).create(true).open(path)?,
        None => OpenOptions::new().write(true).open("NUL")?,
    })?;

    let desktop = if detached.desktop == Some("hidden") {
        // No process exists yet: the caller can safely use its platform launcher.
        match open_hidden() {
            Ok(desktop) => Some(desktop),
            Err(_) => return Ok(None),
        }
    } else {
        None
    };
    // Only the standard streams and requested desktop pass to the child.
    let mut handles = vec![raw(&stdin), raw(&output)];
    if let Some(desktop) = &desktop {
        handles.push(desktop.raw());
    }
    let mut attributes = AttributeList::new(1)?;
    // SAFETY: `handles` outlives `attributes`, dropped after the create.
    unsafe {
        attributes.set(
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            handles.as_ptr().cast(),
            size_of_val(handles.as_slice()),
        )?;
    }

    // SAFETY: all-zero is a valid value of this plain struct.
    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = u32::try_from(size_of::<STARTUPINFOEXW>()).expect("fits in u32");
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    if detached.hidden_windows {
        startup.StartupInfo.dwFlags |= STARTF_USESHOWWINDOW;
        startup.StartupInfo.wShowWindow = 0; // SW_HIDE
    }
    startup.StartupInfo.hStdInput = raw(&stdin);
    startup.StartupInfo.hStdOutput = raw(&output);
    startup.StartupInfo.hStdError = raw(&output);
    startup.lpAttributeList = attributes.as_ptr();

    let mut desktop_name = desktop.as_ref().map(|_| wide(super::desktop::HIDDEN_NAME));
    if let Some(name) = &mut desktop_name {
        startup.StartupInfo.lpDesktop = name.as_mut_ptr();
    }

    let flags = EXTENDED_STARTUPINFO_PRESENT
        | DETACHED_PROCESS
        | CREATE_NEW_PROCESS_GROUP
        | CREATE_BREAKAWAY_FROM_JOB
        | CREATE_UNICODE_ENVIRONMENT;
    let application = wide(detached.program);
    let mut line = wide(&command_line(detached.program, detached.args));
    let environment = environment_block(detached.env);
    let cwd = wide(detached.cwd);
    // SAFETY: all-zero is a valid value of this plain struct.
    let mut info: PROCESS_INFORMATION = unsafe { zeroed() };
    // SAFETY: every pointer is a valid, NUL-terminated local that outlives
    // the call; the handle list names inheritable handles.
    let created = check(unsafe {
        CreateProcessW(
            application.as_ptr(),
            line.as_mut_ptr(),
            null(),
            null(),
            1,
            flags,
            environment.as_ptr().cast(),
            cwd.as_ptr(),
            &raw const startup.StartupInfo,
            &raw mut info,
        )
    });
    drop(attributes);
    match created {
        Err(err) if err.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) => return Ok(None),
        Err(err) => return Err(err),
        Ok(()) => {}
    }

    // SAFETY: `CreateProcessW` returned new handles nothing else owns; they
    // close here, and the process runs on.
    let process = unsafe { OwnedHandle::from_raw_handle(info.hProcess.cast()) };
    let _thread = unsafe { OwnedHandle::from_raw_handle(info.hThread.cast()) };
    if detached.hidden_windows {
        let watching = crate::os::process::PinnedProcess::open(info.dwProcessId)
            .and_then(|pin| pin.map(|pin| pin.start_window_hiding()).transpose());
        if let Err(error) = watching {
            // No caller receives this PID when watcher setup fails.
            unsafe {
                windows_sys::Win32::System::Threading::TerminateProcess(raw(&process), 1);
                windows_sys::Win32::System::Threading::WaitForSingleObject(raw(&process), 5000);
            }
            return Err(error);
        }
    }
    Ok(Some(info.dwProcessId))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn missing_studio(desktop: Option<&str>) -> Detached<'_> {
        Detached {
            program: "C:\\rbx-forge-missing\\RobloxStudioBeta.exe",
            args: &[],
            cwd: "C:\\",
            env: &[],
            output: None,
            desktop,
            hidden_windows: false,
        }
    }

    #[test]
    fn unavailable_hidden_desktop_returns_without_starting_studio() {
        let result = spawn_with_desktop(&missing_studio(Some("hidden")), || {
            Err(io::Error::from_raw_os_error(ERROR_ACCESS_DENIED as i32))
        });
        assert_eq!(result.unwrap(), None);
    }

    #[test]
    fn other_setup_errors_are_not_hidden_desktop_fallbacks() {
        let detached = Detached {
            output: Some("C:\\rbx-forge-missing\\output.log"),
            ..missing_studio(Some("hidden"))
        };
        let error = spawn_with_desktop(&detached, || {
            Err(io::Error::from_raw_os_error(ERROR_ACCESS_DENIED as i32))
        })
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }
}
