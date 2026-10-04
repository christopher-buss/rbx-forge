//! AppKit visibility targets one PID and never activates the application.

use std::ffi::{CStr, c_char, c_void};
use std::io;
use std::mem::transmute;
use std::time::{Duration, Instant};

/// How long AppKit may take to apply a hide or unhide request.
const SETTLE: Duration = Duration::from_secs(1);

type Object = *mut c_void;
type Selector = *mut c_void;
#[cfg(target_arch = "aarch64")]
type ObjcBool = bool;
#[cfg(not(target_arch = "aarch64"))]
type ObjcBool = i8;

#[link(name = "AppKit", kind = "framework")]
unsafe extern "C" {}

#[link(name = "objc")]
unsafe extern "C" {
    fn objc_getClass(name: *const c_char) -> Object;
    fn sel_registerName(name: *const c_char) -> Selector;
    fn objc_msgSend();
    fn objc_autoreleasePoolPush() -> Object;
    fn objc_autoreleasePoolPop(pool: Object);
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    static kCFRunLoopDefaultMode: *const c_void;
    fn CFRunLoopRunInMode(mode: *const c_void, seconds: f64, return_after_source: bool) -> i32;
}

struct Pool(Object);
impl Drop for Pool {
    fn drop(&mut self) {
        // SAFETY: this thread owns the pool returned by objc_autoreleasePoolPush.
        unsafe { objc_autoreleasePoolPop(self.0) };
    }
}

struct Application {
    object: Object,
    _pool: Pool,
}

impl Application {
    fn open(pid: u32) -> io::Result<Option<Self>> {
        let pid = i32::try_from(pid).map_err(io::Error::other)?;
        // SAFETY: each call scopes autoreleased AppKit objects to this thread.
        let pool = Pool(unsafe { objc_autoreleasePoolPush() });
        // SAFETY: a bounded default-mode turn refreshes AppKit's varying properties.
        unsafe { CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.001, true) };
        // SAFETY: the static class name and selector have the documented PID signature.
        let object = unsafe {
            let class = objc_getClass(c"NSRunningApplication".as_ptr());
            if class.is_null() {
                return Err(io::Error::other("AppKit has no NSRunningApplication class"));
            }
            let selector = sel_registerName(c"runningApplicationWithProcessIdentifier:".as_ptr());
            let send: unsafe extern "C" fn(Object, Selector, i32) -> Object =
                transmute(objc_msgSend as *const ());
            send(class, selector, pid)
        };
        if object.is_null() {
            return Ok(None);
        }
        Ok(Some(Self {
            object,
            _pool: pool,
        }))
    }

    fn boolean(&self, method: &CStr) -> bool {
        // SAFETY: these no-argument NSRunningApplication methods return BOOL.
        unsafe {
            let selector = sel_registerName(method.as_ptr());
            let send: unsafe extern "C" fn(Object, Selector) -> ObjcBool =
                transmute(objc_msgSend as *const ());
            send(self.object, selector) as u8 != 0
        }
    }
}

pub fn hidden(pid: u32) -> io::Result<Option<bool>> {
    Ok(Application::open(pid)?.map(|application| application.boolean(c"isHidden")))
}

/// Request the visibility, then wait for `isHidden` to match. `hide` and
/// `unhide` return NO for another process's app even when they apply.
pub fn set_hidden(
    pid: u32,
    hidden: bool,
    is_alive: impl FnOnce() -> io::Result<bool>,
) -> io::Result<bool> {
    let Some(application) = Application::open(pid)? else {
        return Ok(false);
    };
    if !is_alive()? {
        return Ok(false);
    }
    application.boolean(if hidden { c"hide" } else { c"unhide" });
    let deadline = Instant::now() + SETTLE;
    loop {
        if application.boolean(c"isHidden") == hidden {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        // SAFETY: a bounded default-mode turn refreshes AppKit's varying properties.
        unsafe { CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.01, true) };
    }
}
