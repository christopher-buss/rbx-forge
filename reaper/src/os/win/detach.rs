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
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOEXW,
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
}

fn inheritable(file: File) -> io::Result<File> {
    // SAFETY: the handle is open and owned by `file`.
    check(unsafe { SetHandleInformation(raw(&file), HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) })?;
    Ok(file)
}

/// Start `detached` outside the caller's job, with no console and stdin
/// from `NUL`.
///
/// Returns its PID, or `None` when the caller's job forbids breakaway.
///
/// # Errors
///
/// When the output file cannot be opened or the process cannot start for
/// another reason.
pub fn spawn_detached(detached: &Detached<'_>) -> io::Result<Option<u32>> {
    let stdin = inheritable(File::open("NUL")?)?;
    let output = inheritable(match detached.output {
        Some(path) => OpenOptions::new().append(true).create(true).open(path)?,
        None => OpenOptions::new().write(true).open("NUL")?,
    })?;

    // Only these two handles pass to the child, whatever else is
    // inheritable in this process.
    let handles = [raw(&stdin), raw(&output)];
    let mut attributes = AttributeList::new(1)?;
    // SAFETY: `handles` outlives `attributes`, dropped after the create.
    unsafe {
        attributes.set(
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            handles.as_ptr().cast(),
            size_of_val(&handles),
        )?;
    }

    // SAFETY: all-zero is a valid value of this plain struct.
    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = u32::try_from(size_of::<STARTUPINFOEXW>()).expect("fits in u32");
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = raw(&stdin);
    startup.StartupInfo.hStdOutput = raw(&output);
    startup.StartupInfo.hStdError = raw(&output);
    startup.lpAttributeList = attributes.as_ptr();

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
    unsafe {
        drop(OwnedHandle::from_raw_handle(info.hProcess.cast()));
        drop(OwnedHandle::from_raw_handle(info.hThread.cast()));
    }
    Ok(Some(info.dwProcessId))
}
