//! Windows: the pin is a process handle. Windows never reuses a PID while any
//! handle to the process is open, so the handle always names this process.

use super::StartTime;
use std::ffi::OsString;
use std::io;
use std::os::windows::ffi::OsStringExt;
use std::path::PathBuf;
use std::time::Duration;

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_INVALID_PARAMETER, FILETIME, HANDLE, WAIT_FAILED, WAIT_OBJECT_0,
    WAIT_TIMEOUT,
};
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, PROCESS_ACCESS_RIGHTS, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
};

/// Exit code a killed process reports.
const KILLED_EXIT_CODE: u32 = 1;
/// How long a failed kill waits for a process that is already exiting.
const EXITING_WAIT: Duration = Duration::from_millis(500);
/// Longest path `QueryFullProcessImageNameW` fills (the extended path limit).
const MAX_PATH_UNITS: usize = 32_768;

/// An open process handle, closed on drop.
#[derive(Debug)]
struct Handle(HANDLE);

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: the handle came from `OpenProcess` and is closed only here.
        unsafe { CloseHandle(self.0) };
    }
}

impl Handle {
    /// Open a process. `Ok(None)` when no process has this PID.
    fn open(pid: u32, access: PROCESS_ACCESS_RIGHTS) -> io::Result<Option<Self>> {
        // SAFETY: plain call; a null result is checked below.
        let raw = unsafe { OpenProcess(access, 0, pid) };
        if raw.is_null() {
            let err = io::Error::last_os_error();
            // `OpenProcess` reports an unknown PID as an invalid parameter.
            return if err.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
                Ok(None)
            } else {
                Err(err)
            };
        }

        Ok(Some(Self(raw)))
    }

    /// Wait up to `timeout` for the process to exit. `Ok(true)` once it has.
    fn wait(&self, timeout: Duration) -> io::Result<bool> {
        let millis = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX - 1);
        // SAFETY: the handle is open and has `SYNCHRONIZE` access.
        match unsafe { WaitForSingleObject(self.0, millis) } {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => Ok(false),
            WAIT_FAILED => Err(io::Error::last_os_error()),
            other => Err(io::Error::other(format!("unexpected wait result {other}"))),
        }
    }

    fn has_exited(&self) -> io::Result<bool> {
        self.wait(Duration::ZERO)
    }

    fn creation_time(&self) -> io::Result<StartTime> {
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        // SAFETY: the handle is open; the out pointers are valid locals.
        let ok =
            unsafe { GetProcessTimes(self.0, &mut creation, &mut exit, &mut kernel, &mut user) };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }

        Ok((u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
    }
}

pub fn start_time(pid: u32) -> io::Result<Option<StartTime>> {
    let Some(handle) = Handle::open(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE)?
    else {
        return Ok(None);
    };
    if handle.has_exited()? {
        return Ok(None);
    }

    handle.creation_time().map(Some)
}

/// A process handle with query, wait, and terminate access.
#[derive(Debug)]
pub struct Pin(Handle);

impl Pin {
    pub fn open(pid: u32) -> io::Result<Option<(Self, StartTime)>> {
        let access = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE;
        let Some(handle) = Handle::open(pid, access)? else {
            return Ok(None);
        };
        if handle.has_exited()? {
            return Ok(None);
        }

        let start = handle.creation_time()?;
        Ok(Some((Self(handle), start)))
    }

    pub fn executable_path(&self) -> io::Result<Option<PathBuf>> {
        if self.0.has_exited()? {
            return Ok(None);
        }

        let mut buffer = vec![0_u16; MAX_PATH_UNITS];
        let mut length = u32::try_from(buffer.len()).expect("buffer length fits in u32");
        // SAFETY: the handle is open; `length` holds the buffer's size.
        let ok = unsafe {
            QueryFullProcessImageNameW(
                self.0.0,
                PROCESS_NAME_WIN32,
                buffer.as_mut_ptr(),
                &mut length,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }

        buffer.truncate(length as usize);
        Ok(Some(PathBuf::from(OsString::from_wide(&buffer))))
    }

    pub fn is_alive(&self) -> io::Result<bool> {
        Ok(!self.0.has_exited()?)
    }

    pub fn kill(&self) -> io::Result<bool> {
        if self.0.has_exited()? {
            return Ok(false);
        }

        // SAFETY: the handle is open and has `PROCESS_TERMINATE` access.
        if unsafe { TerminateProcess(self.0.0, KILLED_EXIT_CODE) } == 0 {
            let err = io::Error::last_os_error();
            // Terminating a process that is already exiting fails (access
            // denied) until its exit completes; that is not an error for a
            // caller that wants it gone.
            return if self.0.wait(EXITING_WAIT)? {
                Ok(false)
            } else {
                Err(err)
            };
        }

        Ok(true)
    }

    pub fn kill_group(&self) -> io::Result<bool> {
        self.kill()
    }

    pub fn wait_for_exit(&self, timeout: Duration) -> io::Result<bool> {
        self.0.wait(timeout)
    }
}
