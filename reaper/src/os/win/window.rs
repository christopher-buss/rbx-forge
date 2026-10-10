//! Ask a process to close through its main windows, as a user who clicks the
//! close button would, and tell whether a modal dialog blocks them.
//!
//! A main window is a visible top-level window with no owner that is neither
//! a tool window (a floating panel) nor a console window (the console host
//! draws it for every process attached to it). A process with no visible
//! one may still have a hidden main window: Roblox Studio started hidden
//! keeps its main window hidden. A hidden window counts only when its title
//! ends with [`HIDDEN_MAIN_TITLE_SUFFIX`]; Studio has many other hidden,
//! unowned helper windows.

use std::io;
use windows_sys::Win32::System::StationsAndDesktops::EnumDesktopWindows;

use windows_sys::Win32::Foundation::{HWND, LPARAM, TRUE};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::IsWindowEnabled;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GW_OWNER, GWL_EXSTYLE, GetClassNameW, GetWindow, GetWindowLongPtrW, GetWindowTextW,
    GetWindowThreadProcessId, IsWindowVisible, PostMessageW, WM_CLOSE, WS_EX_TOOLWINDOW,
};

/// Window classes of console windows.
const CONSOLE_CLASSES: [&str; 2] = ["ConsoleWindowClass", "PseudoConsoleWindow"];
/// Longest class name Windows stores, plus its NUL.
const CLASS_NAME_UNITS: usize = 257;
/// Longest window title read; longer titles are cut.
const TITLE_UNITS: usize = 1024;
/// The title end of a hidden main window: Studio titles its main window
/// `<place> - Roblox Studio`.
pub const HIDDEN_MAIN_TITLE_SUFFIX: &str = " - Roblox Studio";

/// What decides whether a top-level window is a main window.
#[derive(Clone, Copy, Debug, Default)]
struct Facts {
    visible: bool,
    owned: bool,
    tool: bool,
    console: bool,
    /// Its title ends with [`HIDDEN_MAIN_TITLE_SUFFIX`].
    titled: bool,
}

/// What the enumeration callback collects.
struct Search {
    pid: u32,
    visible: Vec<HWND>,
    hidden: Vec<HWND>,
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
    let desktop = super::desktop::for_process(pid)?;
    let windows = main_windows(pid, &desktop)?;
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

/// Whether a main window of the process `pid` is disabled. Windows disables
/// the owner of a modal dialog while the dialog is up (Studio's "Save
/// changes?" and "Opening place" dialogs do so), and such a window ignores
/// `WM_CLOSE`.
///
/// # Errors
///
/// When the windows cannot be listed.
pub fn is_blocked(pid: u32) -> io::Result<bool> {
    let desktop = super::desktop::for_process(pid)?;
    Ok(main_windows(pid, &desktop)?
        .into_iter()
        // SAFETY: plain call; a closed window reads as enabled.
        .any(|window| unsafe { IsWindowEnabled(window) } == 0))
}

/// The titled Studio main window, rather than a tooltip or helper window.
pub fn studio_main_window(pid: u32) -> io::Result<Option<HWND>> {
    let desktop = super::desktop::for_process(pid)?;
    Ok(main_windows(pid, &desktop)?
        .into_iter()
        .find(|window| title(*window).ends_with(HIDDEN_MAIN_TITLE_SUFFIX)))
}

/// An exact top-level title belonging to this PID, on its desktop.
pub fn titled_window(pid: u32, wanted: &str) -> io::Result<Option<HWND>> {
    struct TitledSearch<'a> {
        pid: u32,
        wanted: &'a str,
        found: Option<HWND>,
    }
    unsafe extern "system" fn collect_title(window: HWND, context: LPARAM) -> i32 {
        // SAFETY: the caller keeps this search alive during enumeration.
        let search = unsafe { &mut *(context as *mut TitledSearch<'_>) };
        let mut owner = 0;
        // SAFETY: a window query writes a local PID.
        unsafe { GetWindowThreadProcessId(window, &raw mut owner) };
        if owner == search.pid && title(window) == search.wanted {
            search.found = Some(window);
        }
        TRUE
    }
    let mut search = TitledSearch {
        pid,
        wanted,
        found: None,
    };
    let desktop = super::desktop::for_process(pid)?;
    let ok = unsafe {
        EnumDesktopWindows(
            desktop.raw(),
            Some(collect_title),
            (&raw mut search) as LPARAM,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(search.found)
}

/// The main windows of the process `pid`, in Z order: the visible ones, or
/// when there are none, the hidden titled ones. The caller keeps the desktop
/// open until every query or post on these handles has finished.
fn main_windows(pid: u32, desktop: &super::desktop::Desktop) -> io::Result<Vec<HWND>> {
    let mut search = Search {
        pid,
        visible: Vec::new(),
        hidden: Vec::new(),
    };
    // SAFETY: the callback reads `search` only during this call.
    let ok =
        unsafe { EnumDesktopWindows(desktop.raw(), Some(collect), (&raw mut search) as LPARAM) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }

    Ok(if search.visible.is_empty() {
        search.hidden
    } else {
        search.visible
    })
}

/// `EnumWindows` callback: sort the window when it is a main window of the
/// searched process.
unsafe extern "system" fn collect(window: HWND, search: LPARAM) -> i32 {
    // SAFETY: `main_windows` passes a live `Search` for the whole call.
    let search = unsafe { &mut *(search as *mut Search) };
    let mut owner_pid = 0_u32;
    // SAFETY: plain call; the out pointer is a local.
    unsafe { GetWindowThreadProcessId(window, &raw mut owner_pid) };
    if owner_pid == search.pid {
        match kind(facts(window)) {
            Some(Kind::Visible) => search.visible.push(window),
            Some(Kind::Hidden) => search.hidden.push(window),
            None => {}
        }
    }

    TRUE
}

/// Which list a main window goes in.
#[derive(Debug, PartialEq, Eq)]
enum Kind {
    Visible,
    Hidden,
}

/// Whether a window is a main window, and whether it is visible.
fn kind(facts: Facts) -> Option<Kind> {
    if facts.owned || facts.tool || facts.console {
        return None;
    }

    if facts.visible {
        Some(Kind::Visible)
    } else if facts.titled {
        Some(Kind::Hidden)
    } else {
        None
    }
}

fn facts(window: HWND) -> Facts {
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
    let tool = (extended as u32) & WS_EX_TOOLWINDOW != 0;
    Facts {
        visible,
        owned: !owner.is_null(),
        tool,
        console: is_console(window),
        titled: title(window).ends_with(HIDDEN_MAIN_TITLE_SUFFIX),
    }
}

fn title(window: HWND) -> String {
    let mut buffer = [0_u16; TITLE_UNITS];
    let capacity = i32::try_from(buffer.len()).expect("fits in i32");
    // SAFETY: the buffer holds `capacity` units.
    let length = unsafe { GetWindowTextW(window, buffer.as_mut_ptr(), capacity) };
    let length = usize::try_from(length).unwrap_or(0);
    String::from_utf16_lossy(&buffer[..length])
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

#[cfg(test)]
mod tests {
    use super::{Facts, Kind, kind};

    #[test]
    fn a_visible_unowned_window_is_a_main_window() {
        let facts = Facts {
            visible: true,
            ..Facts::default()
        };
        assert_eq!(kind(facts), Some(Kind::Visible));
    }

    #[test]
    fn a_hidden_window_counts_only_with_the_studio_title() {
        assert_eq!(kind(Facts::default()), None);
        let titled = Facts {
            titled: true,
            ..Facts::default()
        };
        assert_eq!(kind(titled), Some(Kind::Hidden));
    }

    #[test]
    fn owned_tool_and_console_windows_are_never_main_windows() {
        for facts in [
            Facts {
                owned: true,
                ..Facts::default()
            },
            Facts {
                tool: true,
                ..Facts::default()
            },
            Facts {
                console: true,
                ..Facts::default()
            },
        ] {
            let visible = Facts {
                visible: true,
                titled: true,
                ..facts
            };
            assert_eq!(kind(visible), None);
        }
    }
}
