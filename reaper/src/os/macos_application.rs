//! AppKit visibility targets one PID and never activates the application.

use std::ffi::{CStr, CString, c_char, c_void};
use std::io;
use std::mem::{size_of, transmute};
use std::sync::{Arc, Condvar, Mutex};
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

pub fn active(pid: u32) -> io::Result<Option<bool>> {
    Ok(Application::open(pid)?.map(|application| application.boolean(c"isActive")))
}

/// Unhide the app and request activation without waiting for either.
pub fn activate(pid: u32, is_alive: impl FnOnce() -> io::Result<bool>) -> io::Result<bool> {
    let Some(application) = Application::open(pid)? else {
        return Ok(false);
    };
    if !is_alive()? {
        return Ok(false);
    }
    application.boolean(c"unhide");
    // SAFETY: activateWithOptions: takes one NSUInteger and returns BOOL.
    unsafe {
        let send: unsafe extern "C" fn(Object, Selector, usize) -> ObjcBool =
            transmute(objc_msgSend as *const ());
        send(
            application.object,
            sel_registerName(c"activateWithOptions:".as_ptr()),
            0,
        );
    }
    Ok(true)
}

/// The PID of the frontmost app, or none when no app is frontmost.
pub fn frontmost() -> io::Result<Option<u32>> {
    // SAFETY: each call scopes autoreleased AppKit objects to this thread.
    let _pool = Pool(unsafe { objc_autoreleasePoolPush() });
    // SAFETY: a bounded default-mode turn refreshes AppKit's varying properties.
    unsafe { CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.001, true) };
    // SAFETY: sharedWorkspace and frontmostApplication take no arguments and return objects.
    let application = unsafe {
        send0(
            send0(class(c"NSWorkspace")?, c"sharedWorkspace"),
            c"frontmostApplication",
        )
    };
    if application.is_null() {
        return Ok(None);
    }
    // SAFETY: processIdentifier is a no-argument NSRunningApplication method returning pid_t.
    let pid = unsafe {
        let send: unsafe extern "C" fn(Object, Selector) -> i32 =
            transmute(objc_msgSend as *const ());
        send(application, sel_registerName(c"processIdentifier".as_ptr()))
    };
    Ok(u32::try_from(pid).ok())
}

/// How long LaunchServices may take to report a launch.
const LAUNCH_DEADLINE: Duration = Duration::from_secs(60);
/// `BLOCK_IS_GLOBAL`: `Block_copy` returns the block itself, so the
/// completion's context outlives the copy LaunchServices keeps.
const BLOCK_IS_GLOBAL: i32 = 1 << 28;

#[link(name = "System")]
unsafe extern "C" {
    static _NSConcreteGlobalBlock: c_void;
}

/// What [`launch`] starts: an app bundle with its arguments and environment.
pub struct Launch<'a> {
    pub bundle: &'a str,
    pub args: &'a [String],
    pub env: &'a [(String, String)],
    /// Bring the app to the front; otherwise it never activates.
    pub activates: bool,
    /// Hide the app as soon as LaunchServices reports it.
    pub hides: bool,
}

type Outcome = Arc<(Mutex<Option<Result<i32, String>>>, Condvar)>;

#[repr(C)]
struct BlockDescriptor {
    reserved: usize,
    size: usize,
}

/// A block literal with the ABI of `^(NSRunningApplication *, NSError *)`.
#[repr(C)]
struct Completion {
    isa: *const c_void,
    flags: i32,
    reserved: i32,
    invoke: unsafe extern "C" fn(*mut Completion, Object, Object),
    descriptor: *const BlockDescriptor,
    hides: bool,
    outcome: Outcome,
}

static COMPLETION_DESCRIPTOR: BlockDescriptor = BlockDescriptor {
    reserved: 0,
    size: size_of::<Completion>(),
};

unsafe fn send0(object: Object, method: &CStr) -> Object {
    // SAFETY: the caller names a no-argument method that returns an object.
    unsafe {
        let send: unsafe extern "C" fn(Object, Selector) -> Object =
            transmute(objc_msgSend as *const ());
        send(object, sel_registerName(method.as_ptr()))
    }
}

unsafe fn send1(object: Object, method: &CStr, argument: Object) -> Object {
    // SAFETY: the caller names a one-object-argument method.
    unsafe {
        let send: unsafe extern "C" fn(Object, Selector, Object) -> Object =
            transmute(objc_msgSend as *const ());
        send(object, sel_registerName(method.as_ptr()), argument)
    }
}

unsafe fn send_bool(object: Object, method: &CStr, value: bool) {
    // SAFETY: the caller names a setter that takes one BOOL.
    unsafe {
        let send: unsafe extern "C" fn(Object, Selector, ObjcBool) =
            transmute(objc_msgSend as *const ());
        send(
            object,
            sel_registerName(method.as_ptr()),
            ObjcBool::from(value),
        );
    }
}

fn class(name: &CStr) -> io::Result<Object> {
    // SAFETY: the name is a NUL-terminated class name.
    let class = unsafe { objc_getClass(name.as_ptr()) };
    if class.is_null() {
        return Err(io::Error::other(format!(
            "AppKit has no {} class",
            name.to_string_lossy()
        )));
    }
    Ok(class)
}

fn string(text: &str) -> io::Result<Object> {
    let text = CString::new(text).map_err(io::Error::other)?;
    // SAFETY: stringWithUTF8String: copies the NUL-terminated UTF-8 text.
    let object = unsafe {
        let send: unsafe extern "C" fn(Object, Selector, *const c_char) -> Object =
            transmute(objc_msgSend as *const ());
        send(
            class(c"NSString")?,
            sel_registerName(c"stringWithUTF8String:".as_ptr()),
            text.as_ptr(),
        )
    };
    if object.is_null() {
        return Err(io::Error::other("text is not valid UTF-8"));
    }
    Ok(object)
}

unsafe extern "C" fn complete(block: *mut Completion, application: Object, error: Object) {
    // SAFETY: LaunchServices passes the block it was given, alive until `launch` returns or leaks it.
    let completion = unsafe { &*block };
    let result = if application.is_null() {
        // SAFETY: a failed launch reports an NSError, whose description is an NSString.
        let reason = unsafe {
            let description = if error.is_null() {
                std::ptr::null_mut()
            } else {
                send0(error, c"localizedDescription")
            };
            let send: unsafe extern "C" fn(Object, Selector) -> *const c_char =
                transmute(objc_msgSend as *const ());
            let text = if description.is_null() {
                std::ptr::null()
            } else {
                send(description, sel_registerName(c"UTF8String".as_ptr()))
            };
            if text.is_null() {
                "LaunchServices reported no app".to_owned()
            } else {
                CStr::from_ptr(text).to_string_lossy().into_owned()
            }
        };
        Err(reason)
    } else {
        // SAFETY: processIdentifier and hide are no-argument NSRunningApplication methods.
        unsafe {
            if completion.hides {
                let send: unsafe extern "C" fn(Object, Selector) -> ObjcBool =
                    transmute(objc_msgSend as *const ());
                send(application, sel_registerName(c"hide".as_ptr()));
            }
            let send: unsafe extern "C" fn(Object, Selector) -> i32 =
                transmute(objc_msgSend as *const ());
            Ok(send(
                application,
                sel_registerName(c"processIdentifier".as_ptr()),
            ))
        }
    };
    // Once the result is stored, `launch` may free the block: own the outcome first.
    let outcome = Arc::clone(&completion.outcome);
    let (slot, ready) = &*outcome;
    let mut guard = slot
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    *guard = Some(result);
    ready.notify_all();
    drop(guard);
}

/// Launch a new instance of an app bundle through LaunchServices and return
/// its PID. Without `activates`, the app never becomes frontmost.
pub fn launch(request: &Launch<'_>) -> io::Result<u32> {
    // SAFETY: each call scopes autoreleased AppKit objects to this thread.
    let _pool = Pool(unsafe { objc_autoreleasePoolPush() });
    let path = string(request.bundle)?;
    // SAFETY: each message below names a documented Foundation or AppKit selector with
    // matching argument and return types.
    let (workspace, url, configuration) = unsafe {
        let send: unsafe extern "C" fn(Object, Selector, Object, ObjcBool) -> Object =
            transmute(objc_msgSend as *const ());
        let url = send(
            class(c"NSURL")?,
            sel_registerName(c"fileURLWithPath:isDirectory:".as_ptr()),
            path,
            ObjcBool::from(true),
        );
        let arguments = send0(class(c"NSMutableArray")?, c"array");
        for argument in request.args {
            send1(arguments, c"addObject:", string(argument)?);
        }
        let environment = send0(class(c"NSMutableDictionary")?, c"dictionary");
        let set: unsafe extern "C" fn(Object, Selector, Object, Object) =
            transmute(objc_msgSend as *const ());
        for (name, value) in request.env {
            set(
                environment,
                sel_registerName(c"setObject:forKey:".as_ptr()),
                string(value)?,
                string(name)?,
            );
        }
        let configuration = send0(class(c"NSWorkspaceOpenConfiguration")?, c"configuration");
        send_bool(configuration, c"setActivates:", request.activates);
        send_bool(configuration, c"setCreatesNewApplicationInstance:", true);
        send_bool(configuration, c"setAddsToRecentItems:", false);
        send_bool(configuration, c"setPromptsUserIfNeeded:", false);
        send1(configuration, c"setArguments:", arguments);
        send1(configuration, c"setEnvironment:", environment);
        let workspace = send0(class(c"NSWorkspace")?, c"sharedWorkspace");
        (workspace, url, configuration)
    };
    let outcome: Outcome = Arc::new((Mutex::new(None), Condvar::new()));
    let block = Box::new(Completion {
        isa: &raw const _NSConcreteGlobalBlock,
        flags: BLOCK_IS_GLOBAL,
        reserved: 0,
        invoke: complete,
        descriptor: &raw const COMPLETION_DESCRIPTOR,
        hides: request.hides,
        outcome: Arc::clone(&outcome),
    });
    let block = Box::into_raw(block);
    // SAFETY: openApplicationAtURL:configuration:completionHandler: takes a URL, a
    // configuration, and a block; the global block is never copied away from `block`.
    unsafe {
        let send: unsafe extern "C" fn(Object, Selector, Object, Object, *mut Completion) =
            transmute(objc_msgSend as *const ());
        send(
            workspace,
            sel_registerName(c"openApplicationAtURL:configuration:completionHandler:".as_ptr()),
            url,
            configuration,
            block,
        );
    }
    let (slot, ready) = &*outcome;
    let guard = slot
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (mut guard, _) = ready
        .wait_timeout_while(guard, LAUNCH_DEADLINE, |result| result.is_none())
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(result) = guard.take() else {
        // LaunchServices may still call the block: it stays allocated.
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "LaunchServices did not report the launch",
        ));
    };
    drop(guard);
    // SAFETY: the completion ran once and LaunchServices never calls it again.
    drop(unsafe { Box::from_raw(block) });
    let pid = result.map_err(io::Error::other)?;
    u32::try_from(pid).map_err(io::Error::other)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_process_without_an_app_is_neither_active_nor_activated() {
        let pid = u32::MAX >> 1;
        assert_eq!(active(pid).unwrap(), None);
        assert!(!activate(pid, || Ok(true)).unwrap());
    }

    #[test]
    fn the_frontmost_app_is_never_this_test() {
        assert_ne!(frontmost().unwrap(), Some(std::process::id()));
    }

    #[test]
    fn launch_reports_a_missing_bundle() {
        let error = launch(&Launch {
            bundle: "/nonexistent/forge-missing.app",
            args: &[],
            env: &[],
            activates: false,
            hides: true,
        })
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::Other);
    }

    #[test]
    fn launch_rejects_text_with_a_nul() {
        let args = ["a\0b".to_owned()];
        let error = launch(&Launch {
            bundle: "/nonexistent/forge-missing.app",
            args: &args,
            env: &[],
            activates: false,
            hides: false,
        })
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::Other);
    }
}
