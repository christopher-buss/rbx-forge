//! Ask a process to close through its main windows, as a user who clicks the
//! close button would. A main window is a visible top-level window with no
//! owner that is neither a tool window (a floating panel) nor a console
//! window (the console host draws it for every process attached to it).

use std::io;

use windows_sys::Win32::Foundation::{HWND, LPARAM, TRUE};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GW_OWNER, GWL_EXSTYLE, GetClassNameW, GetWindow, GetWindowLongPtrW,
    GetWindowThreadProcessId, IsWindowVisible, PostMessageW, WM_CLOSE, WS_EX_TOOLWINDOW,
};

/// Window classes of console windows.
const CONSOLE_CLASSES: [&str; 2] = ["ConsoleWindowClass", "PseudoConsoleWindow"];
/// Longest class name Windows stores, plus its NUL.
const CLASS_NAME_UNITS: usize = 257;

/// What the enumeration callback collects.
struct Search {
    pid: u32,
    windows: Vec<HWND>,
}

/// Post `WM_CLOSE` to every main window of the process `pid`.
///
/// Returns `Ok(false)` when it has no main window.
///
/// # Errors
///
/// When the windows cannot be listed, or every post failed (for example to
/// an elevated process).
pub fn close_main_windows(pid: u32) -> io::Result<bool> {
    let windows = main_windows(pid)?;
    let mut last_error = None;
    let mut posted = 0_usize;
    for window in &windows {
        // SAFETY: plain call; a window that closed meanwhile fails the post.
        if unsafe { PostMessageW(*window, WM_CLOSE, 0, 0) } == 0 {
            last_error = Some(io::Error::last_os_error());
        } else {
            posted += 1;
        }
    }

    match last_error {
        Some(err) if posted == 0 => Err(err),
        _ => Ok(posted > 0),
    }
}

/// The main windows of the process `pid`, in Z order.
fn main_windows(pid: u32) -> io::Result<Vec<HWND>> {
    let mut search = Search {
        pid,
        windows: Vec::new(),
    };
    // SAFETY: the callback reads `search` only during this call.
    let ok = unsafe { EnumWindows(Some(collect), (&raw mut search) as LPARAM) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }

    Ok(search.windows)
}

/// `EnumWindows` callback: keep the window when it is a main window of the
/// searched process.
unsafe extern "system" fn collect(window: HWND, search: LPARAM) -> i32 {
    // SAFETY: `main_windows` passes a live `Search` for the whole call.
    let search = unsafe { &mut *(search as *mut Search) };
    let mut owner_pid = 0_u32;
    // SAFETY: plain call; the out pointer is a local.
    unsafe { GetWindowThreadProcessId(window, &raw mut owner_pid) };
    if owner_pid == search.pid && is_main_window(window) {
        search.windows.push(window);
    }

    TRUE
}

fn is_main_window(window: HWND) -> bool {
    // SAFETY: plain calls on a window handle; a closed window reads as none.
    let (visible, owner, extended) = unsafe {
        (
            IsWindowVisible(window) != 0,
            GetWindow(window, GW_OWNER),
            GetWindowLongPtrW(window, GWL_EXSTYLE),
        )
    };
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "the extended style fits in the low 32 bits"
    )]
    let is_tool = (extended as u32) & WS_EX_TOOLWINDOW != 0;
    visible && owner.is_null() && !is_tool && !is_console(window)
}

fn is_console(window: HWND) -> bool {
    let mut buffer = [0_u16; CLASS_NAME_UNITS];
    let capacity = i32::try_from(buffer.len()).expect("fits in i32");
    // SAFETY: the buffer holds `capacity` units.
    let length = unsafe { GetClassNameW(window, buffer.as_mut_ptr(), capacity) };
    let length = usize::try_from(length).unwrap_or(0);
    let class = String::from_utf16_lossy(&buffer[..length]);
    CONSOLE_CLASSES.contains(&class.as_str())
}
