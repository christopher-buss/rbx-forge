//! Activate only the verified Studio before opening its File menu.
use std::ptr::null_mut;
use std::time::Instant;
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::SetFocus;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowThreadProcessId, MSG, PM_NOREMOVE, PeekMessageW,
    SetForegroundWindow,
};

struct InputQueues {
    current: u32,
    other: u32,
}

impl InputQueues {
    fn join(current: u32, other: u32) -> Option<Self> {
        if other == 0 || current == other {
            return None;
        }
        // SAFETY: thread IDs are queried on the caller's attached desktop.
        (unsafe { AttachThreadInput(current, other, 1) } != 0).then_some(Self { current, other })
    }
}

impl Drop for InputQueues {
    fn drop(&mut self) {
        // SAFETY: this guard owns one successful input-queue attachment.
        unsafe { AttachThreadInput(self.current, self.other, 0) };
    }
}

pub fn activate(pid: u32, window: HWND, deadline: Instant) {
    if Instant::now() >= deadline {
        return;
    }
    let mut actual = 0;
    // SAFETY: plain queries; the caller holds the Studio's process pin.
    let target = unsafe { GetWindowThreadProcessId(window, &raw mut actual) };
    if actual != pid {
        return;
    }
    // Input queues join only for activation; UIA runs after they separate.
    unsafe {
        let mut message: MSG = std::mem::zeroed();
        PeekMessageW(&raw mut message, null_mut(), 0, 0, PM_NOREMOVE);
        let current = GetCurrentThreadId();
        let front = GetWindowThreadProcessId(GetForegroundWindow(), null_mut());
        let _foreground = InputQueues::join(current, front);
        let _studio = (target != front)
            .then(|| InputQueues::join(current, target))
            .flatten();
        if Instant::now() < deadline {
            SetForegroundWindow(window);
        }
        if Instant::now() < deadline {
            SetFocus(window);
        }
    }
}
