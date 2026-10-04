//! The shared hidden desktop and the desktop of a pinned process.

use std::io;
use std::mem::size_of;
use std::ptr::null;
use std::sync::OnceLock;

use windows_sys::Win32::Foundation::{HWND, LPARAM, TRUE};
use windows_sys::Win32::System::StationsAndDesktops::{
    CloseDesktop, CreateDesktopW, DESKTOP_CREATEWINDOW, DESKTOP_ENUMERATE, DESKTOP_READOBJECTS,
    DESKTOP_WRITEOBJECTS, EnumDesktopWindows, EnumDesktopsW, GetProcessWindowStation,
    GetThreadDesktop, GetUserObjectInformationW, HDESK, OpenDesktopW, SetThreadDesktop, UOI_NAME,
};
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

use super::{check, wide};

pub const HIDDEN_NAME: &str = "RbxForgeHidden";
const ACCESS: u32 =
    DESKTOP_CREATEWINDOW | DESKTOP_ENUMERATE | DESKTOP_READOBJECTS | DESKTOP_WRITEOBJECTS;
static HIDDEN: OnceLock<Desktop> = OnceLock::new();

/// An owned desktop handle. The shared hidden handle lives until process exit.
pub struct Desktop(HDESK);

// SAFETY: Windows desktop handles can be queried from any thread. Attachment
// changes only the calling thread, and the handle remains owned by this object.
unsafe impl Send for Desktop {}
unsafe impl Sync for Desktop {}

impl Drop for Desktop {
    fn drop(&mut self) {
        // SAFETY: this handle came from OpenDesktopW/CreateDesktopW, once.
        unsafe { CloseDesktop(self.0) };
    }
}

impl Desktop {
    pub fn raw(&self) -> HDESK {
        self.0
    }

    pub fn name(&self) -> io::Result<String> {
        name(self.0)
    }

    /// Attach a fresh worker thread before it creates windows or initializes UIA.
    pub fn attach(&self) -> io::Result<()> {
        // SAFETY: a live desktop handle. Windows rejects a thread with windows.
        check(unsafe { SetThreadDesktop(self.0) })
    }
}

/// Open or make the desktop. Never release its last forge handle deliberately.
pub fn open_hidden() -> io::Result<&'static Desktop> {
    if let Some(desktop) = HIDDEN.get() {
        return Ok(desktop);
    }
    let title = wide(HIDDEN_NAME);
    // SAFETY: terminated name; the handle is checked and owned below.
    let mut handle = unsafe { OpenDesktopW(title.as_ptr(), 0, 0, ACCESS) };
    if handle.is_null() {
        // SAFETY: default device and security, terminated name. A concurrent
        // creation opens the same named desktop rather than making another one.
        handle = unsafe { CreateDesktopW(title.as_ptr(), null(), null(), 0, ACCESS, null()) };
    }
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    let _ = HIDDEN.set(Desktop(handle));
    Ok(HIDDEN.get().expect("the hidden desktop is initialized"))
}

/// Read a user object's name, including a borrowed thread desktop handle.
fn name(handle: HDESK) -> io::Result<String> {
    let mut buffer = [0_u16; 256];
    let mut needed = 0;
    // SAFETY: a live desktop and a buffer with its byte size.
    check(unsafe {
        GetUserObjectInformationW(
            handle,
            UOI_NAME,
            buffer.as_mut_ptr().cast(),
            u32::try_from(size_of::<[u16; 256]>()).expect("fits u32"),
            &raw mut needed,
        )
    })?;
    let end = buffer
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(buffer.len());
    Ok(String::from_utf16_lossy(&buffer[..end]))
}

/// Find the desktop with the process's windows. The caller holds a pin.
pub fn for_process(pid: u32) -> io::Result<Desktop> {
    let mut search = Search {
        pid,
        desktop: None,
        found: false,
    };
    // SAFETY: borrowed station and live callback context for this call.
    check(unsafe {
        EnumDesktopsW(
            GetProcessWindowStation(),
            Some(collect_desktop),
            (&raw mut search) as LPARAM,
        )
    })?;
    if let Some(desktop) = search.desktop {
        return Ok(desktop);
    }
    // Until a process has a window, its desktop is unobservable. A process
    // without windows has nothing to close on the calling desktop either.
    // SAFETY: a borrowed desktop for the current thread.
    let current = unsafe { GetThreadDesktop(GetCurrentThreadId()) };
    let title = wide(&name(current)?);
    // SAFETY: terminated name; returned handle is owned here.
    let opened = unsafe { OpenDesktopW(title.as_ptr(), 0, 0, ACCESS) };
    if opened.is_null() {
        return Err(io::Error::last_os_error());
    }
    Ok(Desktop(opened))
}

struct Search {
    pid: u32,
    desktop: Option<Desktop>,
    found: bool,
}

unsafe extern "system" fn collect_desktop(title: *const u16, context: LPARAM) -> i32 {
    // SAFETY: for_process supplies a live Search for the call's duration.
    let search = unsafe { &mut *(context as *mut Search) };
    if search.desktop.is_some() {
        return TRUE;
    }
    // SAFETY: EnumDesktopsW supplies a terminated name. Inaccessible desktops
    // cannot contain windows that the caller is allowed to control.
    let opened = unsafe { OpenDesktopW(title, 0, 0, ACCESS) };
    if opened.is_null() {
        return TRUE;
    }
    let desktop = Desktop(opened);
    search.found = false;
    // SAFETY: live desktop and Search during the callback.
    unsafe { EnumDesktopWindows(desktop.raw(), Some(collect_window), context as LPARAM) };
    if search.found {
        search.desktop = Some(desktop);
    }
    TRUE
}

unsafe extern "system" fn collect_window(window: HWND, context: LPARAM) -> i32 {
    // SAFETY: collect_desktop supplies a live Search during this call.
    let search = unsafe { &mut *(context as *mut Search) };
    let mut owner = 0;
    // SAFETY: plain query and a writable local.
    unsafe { GetWindowThreadProcessId(window, &raw mut owner) };
    search.found |= owner == search.pid;
    TRUE
}
