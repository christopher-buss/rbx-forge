//! The server end of a session's control pipe (spec #28, IPC): every
//! instance is created with an owner-only DACL and `PIPE_REJECT_REMOTE_CLIENTS`,
//! and the first one with `FILE_FLAG_FIRST_PIPE_INSTANCE`, so no other
//! process owns the name first. All I/O is overlapped and bounded, and
//! [`PipeServer::close`] ends a pending accept.
//!
//! A listening instance always exists while the server is open: a connected
//! instance is handed out only after its replacement is listening, so no
//! other process can create an instance of the name in between (the DACL
//! denies it `FILE_CREATE_PIPE_INSTANCE` anyway).

use std::io;
use std::os::windows::io::OwnedHandle;
use std::ptr::{null, null_mut};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    ERROR_BROKEN_PIPE, ERROR_FILE_NOT_FOUND, ERROR_IO_PENDING, ERROR_NO_DATA,
    ERROR_OPERATION_ABORTED, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, GENERIC_READ, GENERIC_WRITE,
    GetLastError, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, OPEN_EXISTING,
    PIPE_ACCESS_DUPLEX, ReadFile, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT, WriteFile,
};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_ACCEPT_REMOTE_CLIENTS,
    PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES,
    PIPE_WAIT, WaitNamedPipeW,
};
use windows_sys::Win32::System::Threading::{
    INFINITE, WaitForMultipleObjects, WaitForSingleObject,
};

use super::security::{OwnerOnly, Security, security_of_handle};
use super::{Event, owned, raw, wide};

/// Bytes the pipe buffers in each direction.
const BUFFER_BYTES: u32 = 65_536;
/// Bytes one read asks for.
const READ_CHUNK: usize = 4096;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn millis_until(deadline: Instant) -> u32 {
    let left = deadline.saturating_duration_since(Instant::now());
    u32::try_from(left.as_millis()).unwrap_or(INFINITE - 1)
}

/// Run one overlapped call and wait for it, for `stop`, or for the
/// timeout. `start` issues the call with the given `OVERLAPPED`.
///
/// Returns the bytes moved, or `None` when `stop` or the timeout came first
/// (the call is then cancelled and drained).
fn overlapped(
    handle: HANDLE,
    stop: HANDLE,
    timeout_ms: u32,
    start: impl FnOnce(*mut OVERLAPPED) -> i32,
) -> io::Result<Option<u32>> {
    let event = Event::new()?;
    let mut call = OVERLAPPED {
        hEvent: event.handle(),
        ..OVERLAPPED::default()
    };
    if start(&raw mut call) == 0 {
        // SAFETY: plain call right after the failed one.
        let error = unsafe { GetLastError() };
        if error != ERROR_IO_PENDING {
            return Err(io::Error::from_raw_os_error(
                i32::try_from(error).unwrap_or(i32::MAX),
            ));
        }
    }

    let handles = [event.handle(), stop];
    // SAFETY: both handles are open for the whole wait.
    let waited = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, timeout_ms) };
    if waited != WAIT_OBJECT_0 {
        // SAFETY: the call above is in flight on this handle.
        unsafe { CancelIoEx(handle, &raw const call) };
    }

    let mut moved = 0_u32;
    // SAFETY: waits for the call (or its cancel) to finish, so `call` and the
    // caller's buffer stay valid until the OS is done with them.
    if unsafe { GetOverlappedResult(handle, &raw const call, &raw mut moved, 1) } != 0 {
        return Ok(Some(moved));
    }

    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(ERROR_OPERATION_ABORTED as i32) {
        return Ok(None);
    }

    Err(error)
}

/// What [`PipeConnection::read_line`] read.
#[derive(Debug, Eq, PartialEq)]
pub enum ReadLine {
    /// One line, without its newline.
    Line(String),
    /// The client closed the pipe before a whole line came.
    Closed,
    /// The timeout passed, or the connection was closed here.
    TimedOut,
    /// More than the limit came without a newline.
    TooLong,
}

/// One connected client.
#[derive(Debug)]
pub struct PipeConnection {
    /// Taken out on close; each call holds its own reference while it runs.
    handle: Mutex<Option<Arc<OwnedHandle>>>,
    closed: Event,
    /// Bytes read past the last line.
    pending: Mutex<Vec<u8>>,
}

impl PipeConnection {
    fn new(handle: Arc<OwnedHandle>) -> io::Result<Self> {
        Ok(Self {
            handle: Mutex::new(Some(handle)),
            closed: Event::new()?,
            pending: Mutex::new(Vec::new()),
        })
    }

    fn handle(&self) -> Option<Arc<OwnedHandle>> {
        lock(&self.handle).clone()
    }

    /// Read one line: bytes up to a newline, as UTF-8 (lossy).
    ///
    /// # Errors
    ///
    /// When the OS read fails for another reason than a closed pipe.
    pub fn read_line(&self, max_bytes: usize, timeout: Duration) -> io::Result<ReadLine> {
        let deadline = Instant::now() + timeout;
        let mut pending = lock(&self.pending);
        loop {
            if let Some(end) = pending.iter().position(|&byte| byte == b'\n') {
                let line: Vec<u8> = pending.drain(..=end).collect();
                return Ok(ReadLine::Line(
                    String::from_utf8_lossy(&line[..end]).into_owned(),
                ));
            }
            if pending.len() > max_bytes {
                return Ok(ReadLine::TooLong);
            }
            let Some(handle) = self.handle() else {
                return Ok(ReadLine::TimedOut);
            };

            let mut chunk = [0_u8; READ_CHUNK];
            let length = u32::try_from(chunk.len()).expect("fits in u32");
            let read = overlapped(
                raw(&*handle),
                self.closed.handle(),
                millis_until(deadline),
                |call| {
                    // SAFETY: an open handle; `chunk` outlives the call,
                    // which `overlapped` waits for.
                    unsafe { ReadFile(raw(&*handle), chunk.as_mut_ptr(), length, null_mut(), call) }
                },
            );
            match read {
                Ok(Some(count)) => pending.extend_from_slice(&chunk[..count as usize]),
                Ok(None) => return Ok(ReadLine::TimedOut),
                Err(err) if err.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) => {
                    return Ok(ReadLine::Closed);
                }
                Err(err) => return Err(err),
            }
        }
    }

    /// Write all of `bytes`.
    ///
    /// Returns `false` when the timeout passed, the client left, or the
    /// connection was closed here first.
    ///
    /// # Errors
    ///
    /// When the OS write fails for another reason.
    pub fn write(&self, bytes: &[u8], timeout: Duration) -> io::Result<bool> {
        let deadline = Instant::now() + timeout;
        let mut rest = bytes;
        while !rest.is_empty() {
            let Some(handle) = self.handle() else {
                return Ok(false);
            };
            let length = u32::try_from(rest.len().min(BUFFER_BYTES as usize)).expect("fits");
            let written = overlapped(
                raw(&*handle),
                self.closed.handle(),
                millis_until(deadline),
                |call| {
                    // SAFETY: an open handle; `rest` outlives the call.
                    unsafe { WriteFile(raw(&*handle), rest.as_ptr(), length, null_mut(), call) }
                },
            );
            match written {
                Ok(Some(count)) => rest = &rest[count as usize..],
                Ok(None) => return Ok(false),
                Err(err)
                    if matches!(
                        err.raw_os_error(),
                        Some(code) if code == ERROR_BROKEN_PIPE as i32 || code == ERROR_NO_DATA as i32
                    ) =>
                {
                    return Ok(false);
                }
                Err(err) => return Err(err),
            }
        }
        Ok(true)
    }

    /// Close the connection: a pending read or write ends at once, and the
    /// client sees the pipe close once no call uses it any more. Data
    /// already written stays readable for the client. Safe to call more
    /// than once.
    pub fn close(&self) {
        self.closed.set();
        lock(&self.handle).take();
    }
}

/// Connect to the pipe at `path` (`\\.\pipe\<name>`) as a client, waiting
/// at most `timeout` for a free instance. The server can only identify the
/// client, never act as it.
///
/// Every wait is bounded: `node:net` waits up to 30 s for a busy pipe on a
/// thread of the libuv pool, and keeps its process alive meanwhile, so a
/// server that stopped accepting (a hung supervisor) would hold up the
/// client long after its own timeout.
///
/// Returns `None` when no pipe has the name, or no instance became free in
/// time.
///
/// # Errors
///
/// When the OS refuses the open for another reason, such as access denied.
pub fn connect(path: &str, timeout: Duration) -> io::Result<Option<PipeConnection>> {
    let name = wide(path);
    let deadline = Instant::now() + timeout;
    loop {
        // SAFETY: a NUL-terminated name; no security attributes or template.
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                null_mut(),
            )
        };
        if handle != INVALID_HANDLE_VALUE {
            let handle = owned(handle, INVALID_HANDLE_VALUE)?;
            return PipeConnection::new(Arc::new(handle)).map(Some);
        }

        // SAFETY: plain call right after the failed open.
        let error = unsafe { GetLastError() };
        if error == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if error != ERROR_PIPE_BUSY {
            return Err(io::Error::from_raw_os_error(
                i32::try_from(error).unwrap_or(i32::MAX),
            ));
        }

        // Every instance is taken: wait for one, within the deadline. A
        // wait of 0 would mean the server's default, so stop first.
        let left = millis_until(deadline);
        if left == 0 {
            return Ok(None);
        }
        // SAFETY: a NUL-terminated name. Its failure (time out, or the pipe
        // went away) is read by the next open.
        unsafe { WaitNamedPipeW(name.as_ptr(), left) };
    }
}

/// The server end of a named pipe.
#[derive(Debug)]
pub struct PipeServer {
    name: Vec<u16>,
    mode: u32,
    security: OwnerOnly,
    /// The instance the next client connects to; `None` once closed.
    listening: Mutex<Option<Arc<OwnedHandle>>>,
    stop: Event,
}

impl PipeServer {
    /// Create the pipe `\\.\pipe\<name>` (pass the full path) and its first
    /// instance.
    ///
    /// # Errors
    ///
    /// `ERROR_ACCESS_DENIED` when an instance of the name already exists;
    /// any other create failure.
    pub fn create(path: &str, reject_remote: bool) -> io::Result<Self> {
        let remote = if reject_remote {
            PIPE_REJECT_REMOTE_CLIENTS
        } else {
            PIPE_ACCEPT_REMOTE_CLIENTS
        };
        let server = Self {
            name: wide(path),
            mode: PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | remote,
            security: OwnerOnly::new()?,
            listening: Mutex::new(None),
            stop: Event::new()?,
        };
        let first = server.instance(true)?;
        *lock(&server.listening) = Some(Arc::new(first));
        Ok(server)
    }

    fn instance(&self, first: bool) -> io::Result<OwnedHandle> {
        let attributes = self.security.attributes();
        let first_flag = if first {
            FILE_FLAG_FIRST_PIPE_INSTANCE
        } else {
            0
        };
        // SAFETY: a NUL-terminated name and attributes that outlive the call.
        let handle = unsafe {
            CreateNamedPipeW(
                self.name.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | first_flag,
                self.mode,
                PIPE_UNLIMITED_INSTANCES,
                BUFFER_BYTES,
                BUFFER_BYTES,
                0,
                &raw const attributes,
            )
        };
        owned(handle, INVALID_HANDLE_VALUE)
    }

    fn is_closed(&self) -> bool {
        // SAFETY: the event is open.
        unsafe { WaitForSingleObject(self.stop.handle(), 0) == WAIT_OBJECT_0 }
    }

    /// Wait until a client connects. Returns `None` once the server is
    /// closed.
    ///
    /// # Errors
    ///
    /// When the OS cannot connect or create the next instance.
    pub fn accept(&self) -> io::Result<Option<PipeConnection>> {
        loop {
            let Some(handle) = lock(&self.listening).clone() else {
                return Ok(None);
            };
            if self.is_closed() {
                return Ok(None);
            }

            let connected = overlapped(raw(&*handle), self.stop.handle(), INFINITE, |call| {
                // SAFETY: an open, listening instance.
                unsafe { ConnectNamedPipe(raw(&*handle), call) }
            });
            match connected {
                Ok(Some(_)) => {}
                Ok(None) => return Ok(None),
                Err(err) if err.raw_os_error() == Some(ERROR_PIPE_CONNECTED as i32) => {}
                Err(err) if err.raw_os_error() == Some(ERROR_NO_DATA as i32) => {
                    // A client came and went before the connect: reuse the
                    // instance.
                    // SAFETY: an open instance.
                    unsafe { DisconnectNamedPipe(raw(&*handle)) };
                    continue;
                }
                Err(err) => return Err(err),
            }

            let next = Arc::new(self.instance(false)?);
            let mut slot = lock(&self.listening);
            if slot.is_some() {
                *slot = Some(next);
            }
            drop(slot);
            return PipeConnection::new(handle).map(Some);
        }
    }

    /// Stop listening: a pending [`accept`](Self::accept) returns `None`, and
    /// the listening instance closes. Connections stay open. Safe to call
    /// more than once.
    pub fn close(&self) {
        self.stop.set();
        lock(&self.listening).take();
    }

    /// The owner and DACL of the pipe.
    ///
    /// # Errors
    ///
    /// When the server is closed, or the OS cannot read it.
    pub fn security(&self) -> io::Result<Security> {
        let handle = lock(&self.listening)
            .clone()
            .ok_or_else(|| io::Error::other("the pipe server is closed"))?;
        security_of_handle(&handle)
    }
}

#[cfg(test)]
mod tests {
    use std::fs::OpenOptions;
    use std::io::{Read, Write};
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    use super::{PipeServer, ReadLine, connect};
    use crate::os::win::security::current_user_sid;

    fn name(tag: &str) -> String {
        format!(r"\\.\pipe\forge-test-{tag}-{}", std::process::id())
    }

    #[test]
    fn serves_a_line_and_answers() {
        let path = name("serve");
        let server = Arc::new(PipeServer::create(&path, true).expect("create"));
        let client = thread::spawn({
            let path = path.clone();
            move || {
                let mut pipe = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&path)
                    .expect("connect");
                pipe.write_all(b"hello\nrest").expect("write");
                let mut answer = String::new();
                pipe.read_to_string(&mut answer).expect("read");
                answer
            }
        });

        let connection = server.accept().expect("accept").expect("a client");
        let line = connection
            .read_line(64, Duration::from_secs(5))
            .expect("read");
        assert!(
            connection
                .write(b"answer\n", Duration::from_secs(5))
                .expect("write")
        );
        connection.close();
        assert_eq!(line, ReadLine::Line("hello".to_owned()));
        assert_eq!(client.join().expect("client"), "answer\n");
    }

    #[test]
    fn second_first_instance_is_denied() {
        let path = name("first");
        let _server = PipeServer::create(&path, true).expect("create");
        let second = PipeServer::create(&path, true).expect_err("second create");
        assert_eq!(second.raw_os_error(), Some(5));
    }

    #[test]
    fn read_times_out_and_close_ends_accept() {
        let path = name("timeout");
        let server = Arc::new(PipeServer::create(&path, true).expect("create"));
        let _client = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .expect("connect");
        let connection = server.accept().expect("accept").expect("a client");
        let read = connection
            .read_line(64, Duration::from_millis(50))
            .expect("read");

        let waiting = thread::spawn({
            let server = Arc::clone(&server);
            move || server.accept().expect("accept")
        });
        thread::sleep(Duration::from_millis(50));
        server.close();
        assert_eq!(read, ReadLine::TimedOut);
        assert!(waiting.join().expect("accept thread").is_none());
    }

    #[test]
    fn dacl_is_the_current_user_alone() {
        let server = PipeServer::create(&name("dacl"), true).expect("create");
        let security = server.security().expect("security");
        let user = current_user_sid().expect("sid");
        assert_eq!(security.owner, user);
        assert!(security.protected);
        assert_eq!(security.aces.len(), 1);
        assert_eq!(security.aces[0].kind, "allow");
        assert_eq!(security.aces[0].sid, user);
    }

    #[test]
    fn connect_exchanges_lines_with_the_server() {
        let path = name("connect");
        let server = Arc::new(PipeServer::create(&path, true).expect("create"));
        let accepting = thread::spawn({
            let server = Arc::clone(&server);
            move || server.accept().expect("accept").expect("a client")
        });
        let client = connect(&path, Duration::from_secs(5))
            .expect("connect")
            .expect("an instance");
        let connection = accepting.join().expect("accept thread");

        assert!(
            client
                .write(b"ping\n", Duration::from_secs(5))
                .expect("write")
        );
        let line = connection
            .read_line(64, Duration::from_secs(5))
            .expect("read");
        assert!(
            connection
                .write(b"pong\n", Duration::from_secs(5))
                .expect("write")
        );
        let answer = client.read_line(64, Duration::from_secs(5)).expect("read");
        assert_eq!(
            (line, answer),
            (
                ReadLine::Line("ping".to_owned()),
                ReadLine::Line("pong".to_owned())
            )
        );
    }

    #[test]
    fn connect_finds_no_pipe_at_a_free_name() {
        let found = connect(&name("missing"), Duration::from_secs(5)).expect("connect");
        assert!(found.is_none());
    }

    #[test]
    fn connect_gives_up_on_a_busy_pipe_within_its_timeout() {
        let path = name("busy");
        let _server = PipeServer::create(&path, true).expect("create");
        // Nobody accepts: the one instance is taken by the first client.
        let _first = connect(&path, Duration::from_secs(5))
            .expect("connect")
            .expect("the listening instance");
        let started = std::time::Instant::now();
        let second = connect(&path, Duration::from_millis(300)).expect("connect");
        assert!(second.is_none());
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
