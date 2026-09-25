//! Windows-only primitives for detached sessions and the control pipe:
//!
//! - [`security`]: the current user's SID, owner-only security descriptors,
//!   private files, and security read-back.
//! - [`pipe`]: the named-pipe server of a session's control channel.
//! - [`detach`]: start a process outside the caller's job (`forge up`).
//! - [`window`]: ask a process to close through its main windows.
//! - [`testing`]: helpers that only tests call (jobs, other-user connects,
//!   a window that counts close requests).

pub mod detach;
pub mod pipe;
pub mod security;
pub mod testing;
pub mod window;

use std::ffi::{OsStr, c_void};
use std::io;
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::Threading::{
    CreateEventW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList,
    LPPROC_THREAD_ATTRIBUTE_LIST, SetEvent, UpdateProcThreadAttribute,
};

/// `text` as a NUL-terminated UTF-16 string.
fn wide(text: &str) -> Vec<u16> {
    OsStr::new(text).encode_wide().chain(Some(0)).collect()
}

fn check(ok: i32) -> io::Result<()> {
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn raw(handle: &impl AsRawHandle) -> HANDLE {
    handle.as_raw_handle().cast()
}

/// Take ownership of a handle a create call returned; its failure value is
/// `failed` (null or `INVALID_HANDLE_VALUE`).
fn owned(handle: HANDLE, failed: HANDLE) -> io::Result<OwnedHandle> {
    if handle == failed {
        return Err(io::Error::last_os_error());
    }

    // SAFETY: a create call just returned this handle; nothing else owns it.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle.cast()) })
}

/// A manual-reset event: once set, it stays set for every waiter.
#[derive(Debug)]
struct Event(OwnedHandle);

impl Event {
    fn new() -> io::Result<Self> {
        // SAFETY: default security, manual reset, not set, no name.
        let handle = unsafe { CreateEventW(null(), 1, 0, null()) };
        owned(handle, null_mut()).map(Self)
    }

    fn set(&self) {
        // SAFETY: the event is open for the event's whole life.
        unsafe { SetEvent(raw(&self.0)) };
    }

    fn handle(&self) -> HANDLE {
        raw(&self.0)
    }
}

/// Append one argument the way the Microsoft C runtime reads it back.
fn push_argument(line: &mut String, argument: &str) {
    if !argument.is_empty() && !argument.contains([' ', '\t', '\n', '\x0b', '"']) {
        line.push_str(argument);
        return;
    }

    line.push('"');
    let mut backslashes = 0;
    for character in argument.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                line.push_str(&"\\".repeat(backslashes * 2 + 1));
                line.push('"');
                backslashes = 0;
            }
            _ => {
                line.push_str(&"\\".repeat(backslashes));
                line.push(character);
                backslashes = 0;
            }
        }
    }
    line.push_str(&"\\".repeat(backslashes * 2));
    line.push('"');
}

/// The command line: the quoted program, then the quoted arguments.
fn command_line(program: &str, args: &[String]) -> String {
    let mut line = format!("\"{program}\"");
    for argument in args {
        line.push(' ');
        push_argument(&mut line, argument);
    }
    line
}

/// `K=V\0...\0\0`, as `CREATE_UNICODE_ENVIRONMENT` reads it, sorted by
/// name without case, as Windows expects.
fn environment_block(env: &[(String, String)]) -> Vec<u16> {
    let mut sorted: Vec<&(String, String)> = env.iter().collect();
    sorted.sort_by_key(|(name, _)| name.to_uppercase());
    let mut block: Vec<u16> = Vec::new();
    for (name, value) in sorted {
        block.extend(OsStr::new(&format!("{name}={value}")).encode_wide());
        block.push(0);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    block
}

/// A `PROC_THREAD_ATTRIBUTE_LIST` in an aligned buffer.
struct AttributeList {
    buffer: Vec<usize>,
}

impl AttributeList {
    fn new(count: u32) -> io::Result<Self> {
        let mut size = 0;
        // SAFETY: a size query with a null list; it fails by design.
        unsafe { InitializeProcThreadAttributeList(null_mut(), count, 0, &raw mut size) };
        let mut list = Self {
            buffer: vec![0; size.div_ceil(size_of::<usize>())],
        };
        // SAFETY: the buffer holds at least `size` bytes.
        check(unsafe {
            InitializeProcThreadAttributeList(list.as_ptr(), count, 0, &raw mut size)
        })?;
        Ok(list)
    }

    fn as_ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.buffer.as_mut_ptr().cast()
    }

    /// # Safety
    ///
    /// `value` must stay valid until the list is dropped.
    unsafe fn set(
        &mut self,
        attribute: usize,
        value: *const c_void,
        size: usize,
    ) -> io::Result<()> {
        // SAFETY: the caller keeps `value` alive; the list is initialized.
        check(unsafe {
            UpdateProcThreadAttribute(self.as_ptr(), 0, attribute, value, size, null_mut(), null())
        })
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        // SAFETY: the list was initialized in `new`.
        unsafe { DeleteProcThreadAttributeList(self.as_ptr()) };
    }
}

#[cfg(test)]
mod tests {
    use super::{command_line, environment_block};

    #[test]
    fn command_line_quotes_what_the_c_runtime_splits() {
        let args = [
            "plain".to_owned(),
            String::new(),
            "two words".to_owned(),
            r#"{"a":"b c"}"#.to_owned(),
            r"C:\dir with space\".to_owned(),
        ];
        assert_eq!(
            command_line(r"C:\node.exe", &args),
            r#""C:\node.exe" plain "" "two words" "{\"a\":\"b c\"}" "C:\dir with space\\""#
        );
    }

    #[test]
    fn environment_block_is_sorted_and_double_terminated() {
        let block = environment_block(&[
            ("b".to_owned(), "2".to_owned()),
            ("A".to_owned(), "1".to_owned()),
        ]);
        assert_eq!(String::from_utf16_lossy(&block), "A=1\0b=2\0\0");
        assert_eq!(String::from_utf16_lossy(&environment_block(&[])), "\0\0");
    }
}
