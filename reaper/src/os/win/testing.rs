//! Helpers only tests call (ADR 0001, "Consequences"): a job for the
//! current process, to test detach under a host that forbids breakaway; a
//! pipe connect as another local user, to test the pipe's DACL (S3); and a
//! main window that counts close requests, for the Studio stand-in.

use std::io;
use std::mem::{size_of_val, zeroed};
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::thread;

use windows_sys::Win32::Foundation::{GetLastError, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
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
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentProcess;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, MSG, RegisterClassW,
    TranslateMessage, WM_CLOSE, WNDCLASSW, WS_EX_NOACTIVATE, WS_POPUP, WS_VISIBLE,
};

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

/// `WM_CLOSE` messages the test window got.
static CLOSE_REQUESTS: AtomicU32 = AtomicU32::new(0);

/// Window procedure of the test window: count `WM_CLOSE` and stay open, so
/// the test decides what a close request does.
unsafe extern "system" fn test_window_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_CLOSE {
        CLOSE_REQUESTS.fetch_add(1, Ordering::SeqCst);
        return 0;
    }

    // SAFETY: the default handling of every other message.
    unsafe { DefWindowProcW(window, message, wparam, lparam) }
}

/// Create a window on its own thread with its own message loop: a visible
/// top-level window with no owner (a main window, as Studio has), placed
/// off screen and never activated. It lives until this process exits.
///
/// # Errors
///
/// When the window cannot be made.
pub fn open_test_window() -> io::Result<()> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let class = wide("ForgeTestWindow");
        // SAFETY: null names this process's module.
        let instance = unsafe { GetModuleHandleW(null()) };
        // SAFETY: all-zero is a valid value of this plain struct.
        let mut description: WNDCLASSW = unsafe { zeroed() };
        description.lpfnWndProc = Some(test_window_proc);
        description.hInstance = instance;
        description.lpszClassName = class.as_ptr();
        // SAFETY: the description is complete. A second registration fails,
        // and the create below still finds the class.
        unsafe { RegisterClassW(&raw const description) };
        // SAFETY: a registered class and NUL-terminated names.
        let window = unsafe {
            CreateWindowExW(
                WS_EX_NOACTIVATE,
                class.as_ptr(),
                class.as_ptr(),
                WS_POPUP | WS_VISIBLE,
                -32_000,
                -32_000,
                1,
                1,
                null_mut(),
                null_mut(),
                instance,
                null(),
            )
        };
        if window.is_null() {
            let _ = sender.send(Err(io::Error::last_os_error()));
            return;
        }

        let _ = sender.send(Ok(()));
        // SAFETY: all-zero is a valid value of this plain struct.
        let mut message: MSG = unsafe { zeroed() };
        // SAFETY: the message loop of the thread that owns the window.
        while unsafe { GetMessageW(&raw mut message, null_mut(), 0, 0) } > 0 {
            // SAFETY: a message `GetMessageW` filled.
            unsafe {
                TranslateMessage(&raw const message);
                DispatchMessageW(&raw const message);
            }
        }
    });
    receiver
        .recv()
        .map_err(|_| io::Error::other("the window thread ended"))?
}

/// How many `WM_CLOSE` messages the test window got.
#[must_use]
pub fn close_requests() -> u32 {
    CLOSE_REQUESTS.load(Ordering::SeqCst)
}
