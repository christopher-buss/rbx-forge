//! Identity-pinned hiding shared by the supervisor and CLI processes.
use super::{check, owned, raw, wide};
use crate::os::process::PinnedProcess;
use std::io;
use std::os::windows::io::OwnedHandle;
use std::ptr::null_mut;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND, GetLastError, HWND, LPARAM, TRUE, WAIT_ABANDONED,
    WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::StationsAndDesktops::EnumDesktopWindows;
use windows_sys::Win32::System::Threading::{
    CreateEventW, CreateMutexW, EVENT_MODIFY_STATE, INFINITE, OpenEventW, ReleaseMutex,
    SYNCHRONIZATION_SYNCHRONIZE, SetEvent, WaitForSingleObject,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetWindowThreadProcessId, IsWindowVisible, SW_HIDE, SW_SHOW, SW_SHOWNOACTIVATE,
    SetForegroundWindow, ShowWindowAsync,
};

fn name(pin: &PinnedProcess, kind: &str) -> String {
    format!(
        "Local\\RbxForgeWindows-{kind}-{}-{}",
        pin.pid(),
        pin.start_time()
    )
}

fn event(pin: &PinnedProcess) -> io::Result<Option<OwnedHandle>> {
    let name = wide(&name(pin, "stop"));
    // SAFETY: terminated name, non-inheritable handle, checked below.
    let handle = unsafe {
        OpenEventW(
            EVENT_MODIFY_STATE | SYNCHRONIZATION_SYNCHRONIZE,
            0,
            name.as_ptr(),
        )
    };
    if handle.is_null()
        && io::Error::last_os_error().raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32)
    {
        return Ok(None);
    }
    owned(handle, null_mut()).map(Some)
}

fn stopped(event: &OwnedHandle) -> io::Result<bool> {
    // SAFETY: a live event with synchronize access.
    match unsafe { WaitForSingleObject(raw(event), 0) } {
        WAIT_OBJECT_0 => Ok(true),
        WAIT_TIMEOUT => Ok(false),
        _ => Err(io::Error::last_os_error()),
    }
}

struct Gate(OwnedHandle);
impl Gate {
    fn open(pin: &PinnedProcess) -> io::Result<Self> {
        let name = wide(&name(pin, "gate"));
        let security = super::security::OwnerOnly::new()?;
        // SAFETY: terminated name and descriptor outlive creation.
        owned(
            unsafe { CreateMutexW(&security.attributes(), 0, name.as_ptr()) },
            null_mut(),
        )
        .map(Self)
    }
    fn lock(&self) -> io::Result<Guard<'_>> {
        // SAFETY: a live mutex; this thread's guard releases it.
        match unsafe { WaitForSingleObject(raw(&self.0), INFINITE) } {
            WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(Guard(self)),
            _ => Err(io::Error::last_os_error()),
        }
    }
}
struct Guard<'a>(&'a Gate);
impl Drop for Guard<'_> {
    fn drop(&mut self) {
        // SAFETY: this thread acquired this live mutex exactly once.
        unsafe { ReleaseMutex(raw(&self.0.0)) };
    }
}

fn windows(pid: u32) -> io::Result<Vec<HWND>> {
    struct Search {
        pid: u32,
        windows: Vec<HWND>,
    }
    unsafe extern "system" fn collect(window: HWND, context: LPARAM) -> i32 {
        // SAFETY: enumeration owns this search for the whole callback.
        let search = unsafe { &mut *(context as *mut Search) };
        let mut pid = 0;
        unsafe { GetWindowThreadProcessId(window, &raw mut pid) };
        if pid == search.pid {
            search.windows.push(window);
        }
        TRUE
    }
    let desktop = super::desktop::for_process(pid)?;
    let mut search = Search {
        pid,
        windows: Vec::new(),
    };
    // SAFETY: the desktop and search outlive enumeration.
    check(unsafe {
        EnumDesktopWindows(desktop.raw(), Some(collect), (&raw mut search) as LPARAM)
    })?;
    Ok(search.windows)
}

pub fn running(pin: &PinnedProcess) -> io::Result<bool> {
    if !pin.is_alive()? {
        return Ok(false);
    }
    Ok(event(pin)?.as_ref().map(stopped).transpose()? == Some(false))
}

pub fn visibility(pin: &PinnedProcess) -> io::Result<Option<&'static str>> {
    if !pin.is_alive()? {
        return Ok(None);
    }
    if let Some(event) = event(pin)?
        && !stopped(&event)?
    {
        return Ok(Some("hidden"));
    }
    let windows = windows(pin.pid())?;
    Ok((!windows.is_empty()).then(|| {
        if windows
            .into_iter()
            .any(|window| unsafe { IsWindowVisible(window) } != 0)
        {
            "user"
        } else {
            "hidden"
        }
    }))
}

/// The CLI holds the supervisor's gate while File-menu expansion moves focus.
pub fn with_hiding_paused<T>(
    pin: &PinnedProcess,
    action: impl FnOnce() -> io::Result<T>,
) -> io::Result<T> {
    let event = event(pin)?;
    let gate = event.as_ref().map(|_| Gate::open(pin)).transpose()?;
    let _guard = gate.as_ref().map(Gate::lock).transpose()?;
    let result = action();
    if event.as_ref().map(stopped).transpose()? == Some(false) {
        change(pin, "hidden")?;
    }
    result
}

fn change(pin: &PinnedProcess, state: &str) -> io::Result<bool> {
    if !pin.is_alive()? {
        return Ok(false);
    }
    let windows = windows(pin.pid())?;
    let command = match state {
        "hidden" => SW_HIDE,
        "user" => SW_SHOWNOACTIVATE,
        "active" => SW_SHOW,
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "unknown window visibility",
            ));
        }
    };
    for window in &windows {
        // SAFETY: the live pin prevents PID reuse during window actions.
        unsafe { ShowWindowAsync(*window, command) };
        if state != "hidden" {
            // A hidden STARTUPINFO overrides the first show of a new window.
            unsafe { ShowWindowAsync(*window, command) };
        }
    }
    let deadline = Instant::now() + Duration::from_millis(500);
    while windows.iter().any(|window| {
        // SAFETY: a closed window reads as hidden; the pin preserves identity.
        (unsafe { IsWindowVisible(*window) } != 0) == (state == "hidden")
    }) && pin.is_alive()?
        && Instant::now() < deadline
    {
        std::thread::sleep(Duration::from_millis(1));
    }
    if state == "active"
        && let Some(window) = windows.first()
    {
        // SAFETY: Windows arbitrates foreground activation permission.
        unsafe { SetForegroundWindow(*window) };
    }
    Ok(!windows.is_empty())
}

pub fn set(pin: &PinnedProcess, state: &str) -> io::Result<bool> {
    if state != "hidden" {
        stop(pin)?;
    }
    change(pin, state)
}

pub fn stop(pin: &PinnedProcess) -> io::Result<bool> {
    let alive = pin.is_alive()?;
    let Some(event) = event(pin)? else {
        return Ok(false);
    };
    let gate = Gate::open(pin)?;
    let _guard = gate.lock()?;
    let was_running = !stopped(&event)?;
    // SAFETY: a live manual-reset event shared with its worker.
    check(unsafe { SetEvent(raw(&event)) })?;
    Ok(was_running && alive)
}

pub fn start(pin: &PinnedProcess) -> io::Result<bool> {
    let Some(owned_pin) = PinnedProcess::open(pin.pid())? else {
        return Ok(false);
    };
    if owned_pin.start_time() != pin.start_time() {
        return Ok(false);
    }
    let name = wide(&name(pin, "stop"));
    let security = super::security::OwnerOnly::new()?;
    let deadline = Instant::now() + Duration::from_secs(2);
    let event = loop {
        // SAFETY: terminated name and descriptor; handle checked below.
        let handle = unsafe { CreateEventW(&security.attributes(), 1, 0, name.as_ptr()) };
        let existed = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        let event = owned(handle, null_mut())?;
        if !existed {
            break event;
        }
        if !stopped(&event)? {
            return Ok(true);
        }
        drop(event);
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "previous window watcher did not stop",
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let gate = Gate::open(pin)?;
    std::thread::spawn(move || {
        loop {
            let Ok(guard) = gate.lock() else {
                break;
            };
            if !matches!(stopped(&event), Ok(false)) || !matches!(owned_pin.is_alive(), Ok(true)) {
                break;
            }
            if change(&owned_pin, "hidden").is_err() {
                break;
            }
            drop(guard);
            std::thread::sleep(Duration::from_millis(25));
        }
    });
    Ok(true)
}
