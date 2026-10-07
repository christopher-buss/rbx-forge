//! AX presses do not activate or unhide Studio. Studio restores a minimized
//! window when it saves, so the save minimizes such windows again.

use std::ffi::c_void;
use std::io;
use std::ptr::{self, NonNull};
use std::time::{Duration, Instant};

type CfRef = *const c_void;
type AxError = i32;
const UTF8: u32 = 0x0800_0100;
const ATTRIBUTE_UNSUPPORTED: AxError = -25205;
const NO_VALUE: AxError = -25212;
const API_DISABLED: AxError = -25211;
/// How long after the press Studio may restore its minimized main window. The
/// wait also takes at most half of the save's remaining time.
const RESTORE_GRACE: Duration = Duration::from_secs(2);
const RESTORE_POLL: Duration = Duration::from_millis(10);

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXUIElementCreateApplication(pid: i32) -> CfRef;
    fn AXUIElementGetTypeID() -> usize;
    fn AXUIElementSetMessagingTimeout(element: CfRef, seconds: f32) -> AxError;
    fn AXUIElementCopyAttributeValue(element: CfRef, name: CfRef, value: *mut CfRef) -> AxError;
    fn AXUIElementPerformAction(element: CfRef, action: CfRef) -> AxError;
    fn AXUIElementSetAttributeValue(element: CfRef, name: CfRef, value: CfRef) -> AxError;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    static kCFBooleanTrue: CfRef;
    fn CFRelease(value: CfRef);
    fn CFRetain(value: CfRef) -> CfRef;
    fn CFGetTypeID(value: CfRef) -> usize;
    fn CFArrayGetTypeID() -> usize;
    fn CFArrayGetCount(array: CfRef) -> isize;
    fn CFArrayGetValueAtIndex(array: CfRef, index: isize) -> CfRef;
    fn CFBooleanGetTypeID() -> usize;
    fn CFBooleanGetValue(boolean: CfRef) -> bool;
    fn CFStringGetTypeID() -> usize;
    fn CFStringCreateWithBytes(
        allocator: CfRef,
        bytes: *const u8,
        length: isize,
        encoding: u32,
        external: bool,
    ) -> CfRef;
    fn CFStringGetLength(string: CfRef) -> isize;
    fn CFStringGetMaximumSizeForEncoding(length: isize, encoding: u32) -> isize;
    fn CFStringGetCString(string: CfRef, buffer: *mut u8, capacity: isize, encoding: u32) -> bool;
}

/// Owns one Create, Copy, or Retain reference, including during early returns.
struct Owned(NonNull<c_void>);

impl Owned {
    fn take(value: CfRef) -> io::Result<Self> {
        NonNull::new(value.cast_mut())
            .map(Self)
            .ok_or_else(|| io::Error::other("AX returned a null object"))
    }

    fn as_ref(&self) -> CfRef {
        self.0.as_ptr().cast_const()
    }

    fn text(value: &str) -> io::Result<Self> {
        let length = isize::try_from(value.len()).map_err(io::Error::other)?;
        // SAFETY: the bytes remain valid throughout the copying constructor.
        Self::take(unsafe {
            CFStringCreateWithBytes(ptr::null(), value.as_ptr(), length, UTF8, false)
        })
    }

    fn is_type(&self, type_id: usize) -> bool {
        // SAFETY: Owned always holds a live Core Foundation object.
        unsafe { CFGetTypeID(self.as_ref()) == type_id }
    }

    fn string(&self) -> io::Result<Option<String>> {
        // SAFETY: type IDs do not require a reference.
        if !self.is_type(unsafe { CFStringGetTypeID() }) {
            return Ok(None);
        }
        // SAFETY: the type check proves this is a live CFString.
        let capacity =
            unsafe { CFStringGetMaximumSizeForEncoding(CFStringGetLength(self.as_ref()), UTF8) }
                .checked_add(1)
                .ok_or_else(|| io::Error::other("AX title is too long"))?;
        let mut buffer = vec![0; usize::try_from(capacity).map_err(io::Error::other)?];
        // SAFETY: the output buffer holds capacity bytes, and self is a CFString.
        if !unsafe { CFStringGetCString(self.as_ref(), buffer.as_mut_ptr(), capacity, UTF8) } {
            return Err(io::Error::other("AX title is not UTF-8"));
        }
        buffer.truncate(
            buffer
                .iter()
                .position(|byte| *byte == 0)
                .unwrap_or(buffer.len()),
        );
        String::from_utf8(buffer)
            .map(Some)
            .map_err(io::Error::other)
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: this is exactly the reference adopted by Owned::take.
        unsafe { CFRelease(self.as_ref()) };
    }
}

struct Access {
    deadline: Instant,
}

impl Access {
    fn prepare(&self, element: &Owned) -> io::Result<()> {
        // SAFETY: type IDs do not require a reference.
        if !element.is_type(unsafe { AXUIElementGetTypeID() }) {
            return Err(io::Error::other("AX returned an unexpected element type"));
        }
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "AX save timed out"));
        }
        // An application's timeout is not inherited by elements copied from it.
        check(unsafe { AXUIElementSetMessagingTimeout(element.as_ref(), remaining.as_secs_f32()) })
    }

    fn attribute(&self, element: &Owned, name: &str) -> io::Result<Option<Owned>> {
        self.prepare(element)?;
        let name = Owned::text(name)?;
        let mut value = ptr::null();
        // SAFETY: the element and attribute name are live, and value is an output slot.
        let result =
            unsafe { AXUIElementCopyAttributeValue(element.as_ref(), name.as_ref(), &mut value) };
        if matches!(result, ATTRIBUTE_UNSUPPORTED | NO_VALUE) {
            return Ok(None);
        }
        check(result)?;
        Owned::take(value).map(Some)
    }

    fn elements(&self, element: &Owned, attribute: &str) -> io::Result<Vec<Owned>> {
        let Some(array) = self.attribute(element, attribute)? else {
            return Ok(Vec::new());
        };
        // SAFETY: type IDs do not require a reference.
        if !array.is_type(unsafe { CFArrayGetTypeID() }) {
            return Err(io::Error::other("AX elements are not an array"));
        }
        // SAFETY: array is a live CFArray, retained throughout iteration.
        let count = unsafe { CFArrayGetCount(array.as_ref()) };
        let mut children = Vec::new();
        for index in 0..count {
            // SAFETY: index is within the retained array.
            let child = unsafe { CFArrayGetValueAtIndex(array.as_ref(), index) };
            // SAFETY: children are live CF objects borrowed from the retained array.
            if !child.is_null() && unsafe { CFGetTypeID(child) == AXUIElementGetTypeID() } {
                children.push(Owned::take(unsafe { CFRetain(child) })?);
            }
        }
        Ok(children)
    }

    fn flag(&self, element: &Owned, name: &str) -> io::Result<bool> {
        Ok(self.attribute(element, name)?.is_some_and(|value| {
            // SAFETY: type IDs do not require a reference.
            value.is_type(unsafe { CFBooleanGetTypeID() })
                // SAFETY: the type check proves value is a live CFBoolean.
                && unsafe { CFBooleanGetValue(value.as_ref()) }
        }))
    }

    /// A missing AXEnabled counts as enabled.
    fn enabled(&self, element: &Owned) -> io::Result<bool> {
        Ok(self.attribute(element, "AXEnabled")?.is_none_or(|value| {
            // SAFETY: type IDs do not require a reference.
            !value.is_type(unsafe { CFBooleanGetTypeID() })
                // SAFETY: the type check proves value is a live CFBoolean.
                || unsafe { CFBooleanGetValue(value.as_ref()) }
        }))
    }

    fn minimize(&self, window: &Owned) -> io::Result<()> {
        self.prepare(window)?;
        let name = Owned::text("AXMinimized")?;
        // SAFETY: the window and name are live, and kCFBooleanTrue is a static CFBoolean.
        check(unsafe {
            AXUIElementSetAttributeValue(window.as_ref(), name.as_ref(), kCFBooleanTrue)
        })
    }

    fn named_child(&self, element: &Owned, name: &str) -> io::Result<Option<Owned>> {
        for child in self.elements(element, "AXChildren")? {
            if let Some(title) = self.attribute(&child, "AXTitle")?
                && title.string()?.as_deref() == Some(name)
            {
                return Ok(Some(child));
            }
        }
        Ok(None)
    }
}

fn check(error: AxError) -> io::Result<()> {
    match error {
        0 => Ok(()),
        API_DISABLED => Err(accessibility_denied()),
        error => Err(io::Error::other(format!("AX save failed ({error})"))),
    }
}

fn accessibility_denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "Grant Accessibility access to the terminal running forge in System Settings",
    )
}

pub fn request(pid: u32, deadline: Instant) -> io::Result<String> {
    let pinned = super::process::PinnedProcess::open(pid)?
        .ok_or_else(|| io::Error::other("Studio exited"))?;
    let (access, app) = application(pid, deadline)?;
    let Some(save) = save_item(&access, &app)? else {
        return Ok("no_menu_item".to_owned());
    };
    // Studio enables the item only once it has been the active app.
    if !access.enabled(&save)? {
        return Ok("menu_disabled".to_owned());
    }
    let action = Owned::text("AXPress")?;
    if !pinned.is_alive()? {
        return Err(io::Error::other("Studio identity changed"));
    }
    // Keeping the window minimized is best effort and never blocks the save.
    let minimized = minimized_windows(&access, &app).unwrap_or_default();
    access.prepare(&save)?;
    // SAFETY: AXPress targets the live, exact File > Save to File item.
    check(unsafe { AXUIElementPerformAction(save.as_ref(), action.as_ref()) })?;
    keep_minimized(&pinned, minimized, deadline);
    Ok("requested".to_owned())
}

/// Whether File > Save to File exists and is enabled, without pressing it.
pub fn save_enabled(pid: u32, deadline: Instant) -> io::Result<bool> {
    let (access, app) = application(pid, deadline)?;
    match save_item(&access, &app)? {
        Some(save) => access.enabled(&save),
        None => Ok(false),
    }
}

/// The AX application for a PID, once the accessibility permission is granted.
fn application(pid: u32, deadline: Instant) -> io::Result<(Access, Owned)> {
    // SAFETY: this query neither prompts nor changes the accessibility permission.
    if !unsafe { AXIsProcessTrusted() } {
        return Err(accessibility_denied());
    }
    let pid = i32::try_from(pid).map_err(io::Error::other)?;
    // SAFETY: the constructor returns an owned AX application for this PID.
    let app = Owned::take(unsafe { AXUIElementCreateApplication(pid) })?;
    Ok((Access { deadline }, app))
}

fn save_item(access: &Access, app: &Owned) -> io::Result<Option<Owned>> {
    let Some(bar) = access.attribute(app, "AXMenuBar")? else {
        return Ok(None);
    };
    let Some(file) = access.named_child(&bar, "File")? else {
        return Ok(None);
    };
    for menu in access.elements(&file, "AXChildren")? {
        if let Some(save) = access.named_child(&menu, "Save to File")? {
            return Ok(Some(save));
        }
    }
    Ok(None)
}

/// Studio restores only its place windows, titled `<place> - Roblox Studio`.
fn minimized_windows(access: &Access, app: &Owned) -> io::Result<Vec<Owned>> {
    let mut minimized = Vec::new();
    for window in access.elements(app, "AXWindows")? {
        let title = match access.attribute(&window, "AXTitle")? {
            Some(title) => title.string()?,
            None => None,
        };
        if title.is_some_and(|title| title.ends_with(" - Roblox Studio"))
            && access.flag(&window, "AXMinimized")?
        {
            minimized.push(window);
        }
    }
    Ok(minimized)
}

/// Minimize again each window that Studio restores while it saves. The save
/// already succeeded, so a window that closes or stops answering is skipped.
fn keep_minimized(
    pinned: &super::process::PinnedProcess,
    mut windows: Vec<Owned>,
    deadline: Instant,
) {
    let now = Instant::now();
    // Leave the save its remaining time, so the wait never turns it into a timeout.
    let remaining = deadline.saturating_duration_since(now) / 2;
    let access = Access {
        deadline: now + remaining.min(RESTORE_GRACE),
    };
    while !windows.is_empty() && Instant::now() < access.deadline {
        std::thread::sleep(RESTORE_POLL);
        if !pinned.is_alive().unwrap_or(false) {
            return;
        }
        windows.retain(|window| match access.flag(window, "AXMinimized") {
            Ok(true) => true,
            Ok(false) => {
                let _ = access.minimize(window);
                false
            }
            Err(_) => false,
        });
    }
}

pub fn is_blocked(pid: u32) -> bool {
    // Closing a nongraphical process does not require Accessibility access.
    blocked_windows(pid).unwrap_or(false)
}

fn blocked_windows(pid: u32) -> io::Result<bool> {
    // SAFETY: this query neither prompts nor changes the accessibility permission.
    if !unsafe { AXIsProcessTrusted() } {
        return Ok(false);
    }
    let pid = i32::try_from(pid).map_err(io::Error::other)?;
    let access = Access {
        deadline: Instant::now() + Duration::from_millis(250),
    };
    // SAFETY: the constructor returns an owned AX application for this PID.
    let app = Owned::take(unsafe { AXUIElementCreateApplication(pid) })?;
    for window in access.elements(&app, "AXWindows")? {
        if let Some(modal) = access.attribute(&window, "AXModal")?
            // SAFETY: type IDs do not require a reference.
            && modal.is_type(unsafe { CFBooleanGetTypeID() })
            // SAFETY: the type check proves modal is a live CFBoolean.
            && unsafe { CFBooleanGetValue(modal.as_ref()) }
        {
            return Ok(true);
        }
        if !access.elements(&window, "AXSheets")?.is_empty() {
            return Ok(true);
        }
    }
    Ok(false)
}
