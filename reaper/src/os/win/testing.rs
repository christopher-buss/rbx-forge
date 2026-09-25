//! Helpers only tests call (ADR 0001, "Consequences"): a job for the
//! current process, to test detach under a host that forbids breakaway, and
//! a pipe connect as another local user, to test the pipe's DACL.

use std::io;
use std::mem::{size_of_val, zeroed};
use std::ptr::{null, null_mut};
use std::thread;

use windows_sys::Win32::Foundation::{GetLastError, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Security::{
    ImpersonateLoggedOnUser, LOGON32_LOGON_NETWORK, LOGON32_PROVIDER_DEFAULT, LogonUserW,
    RevertToSelf,
};
use windows_sys::Win32::Storage::FileSystem::{CreateFileW, OPEN_EXISTING};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectExtendedLimitInformation, SetInformationJobObject,
};
use windows_sys::Win32::System::Threading::GetCurrentProcess;

use super::{check, owned, raw, wide};

const GENERIC_READ: u32 = 0x8000_0000;
const GENERIC_WRITE: u32 = 0x4000_0000;

/// Put this process in a new job with `KILL_ON_JOB_CLOSE`, plus
/// `BREAKAWAY_OK` when asked. The job lives until this process exits; then
/// every process still in it dies.
///
/// # Errors
///
/// When the job cannot be made or joined.
pub fn join_new_job(breakaway_ok: bool) -> io::Result<()> {
    // SAFETY: default security, no name.
    let job = owned(unsafe { CreateJobObjectW(null(), null()) }, null_mut())?;
    // SAFETY: all-zero is a valid value of this plain struct.
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        | if breakaway_ok {
            JOB_OBJECT_LIMIT_BREAKAWAY_OK
        } else {
            0
        };
    // SAFETY: the job is open; the struct and its size match the class.
    check(unsafe {
        SetInformationJobObject(
            raw(&job),
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast(),
            u32::try_from(size_of_val(&limits)).expect("fits in u32"),
        )
    })?;
    // SAFETY: the job is open; the pseudo handle names this process.
    check(unsafe { AssignProcessToJobObject(raw(&job), GetCurrentProcess()) })?;
    // The job must outlive this call: its last handle closes at exit.
    std::mem::forget(job);
    Ok(())
}

/// Open the pipe at `path` as another local user, for read and, when asked,
/// write, and close it again.
///
/// Returns 0 when the open worked, else the Win32 error of the open (5 is
/// access denied).
///
/// # Errors
///
/// When the user cannot log on.
pub fn connect_pipe_as(path: &str, user: &str, password: &str, write: bool) -> io::Result<u32> {
    let path = wide(path);
    let user = wide(user);
    let domain = wide(".");
    let password = wide(password);
    // Impersonation is per thread: run it on a thread of its own.
    thread::scope(|scope| {
        scope
            .spawn(|| {
                let mut token: HANDLE = null_mut();
                // SAFETY: NUL-terminated strings; the out pointer is a local.
                check(unsafe {
                    LogonUserW(
                        user.as_ptr(),
                        domain.as_ptr(),
                        password.as_ptr(),
                        LOGON32_LOGON_NETWORK,
                        LOGON32_PROVIDER_DEFAULT,
                        &raw mut token,
                    )
                })?;
                let token = owned(token, null_mut())?;
                // SAFETY: a logon token.
                check(unsafe { ImpersonateLoggedOnUser(raw(&token)) })?;
                let access = GENERIC_READ | if write { GENERIC_WRITE } else { 0 };
                // SAFETY: a NUL-terminated path.
                let pipe = unsafe {
                    CreateFileW(
                        path.as_ptr(),
                        access,
                        0,
                        null(),
                        OPEN_EXISTING,
                        0,
                        null_mut(),
                    )
                };
                // SAFETY: plain call right after the open.
                let error = if pipe == INVALID_HANDLE_VALUE {
                    unsafe { GetLastError() }
                } else {
                    drop(owned(pipe, INVALID_HANDLE_VALUE));
                    0
                };
                // SAFETY: this thread impersonates; revert before it ends.
                unsafe { RevertToSelf() };
                Ok(error)
            })
            .join()
            .map_err(|_| io::Error::other("the connect thread panicked"))?
    })
}
