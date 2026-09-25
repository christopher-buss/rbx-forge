//! Windows-only addon exports: the control pipe's server, detached launch,
//! private files, and the security read-back and helpers that tests use. On
//! other OSes these exports do not exist; `src/native/addon.ts` marks them
//! optional.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Error, Result, Task};
use napi_derive::napi;

use crate::os::win::{detach, pipe, registry, security, testing};

fn to_napi(context: &str, err: &std::io::Error) -> Error {
    Error::from_reason(format!("{context}: {err}"))
}

/// One access control entry.
#[napi(object)]
pub struct NativeAce {
    /// `allow`, `deny`, or `other`.
    pub kind: String,
    pub mask: u32,
    /// `S-1-5-...`; empty for `other`.
    pub sid: String,
}

/// The owner and DACL of an object.
#[napi(object)]
pub struct NativeSecurity {
    pub aces: Vec<NativeAce>,
    pub owner: String,
    /// Inheritance from the parent is off.
    pub protected: bool,
}

fn to_security(security: security::Security) -> NativeSecurity {
    NativeSecurity {
        aces: security
            .aces
            .into_iter()
            .map(|ace| NativeAce {
                kind: ace.kind.to_owned(),
                mask: ace.mask,
                sid: ace.sid,
            })
            .collect(),
        owner: security.owner,
        protected: security.protected,
    }
}

/// What `PipeConnection.readLine` read.
#[napi(object)]
pub struct LineRead {
    /// `line`, `closed`, `timed_out`, or `too_long`.
    pub kind: String,
    /// The line, without its newline, when `kind` is `line`.
    pub line: Option<String>,
}

/// One connected client of a [`PipeServer`].
#[napi]
pub struct PipeConnection {
    inner: Arc<pipe::PipeConnection>,
}

pub struct ReadLineTask {
    connection: Arc<pipe::PipeConnection>,
    max_bytes: usize,
    timeout: Duration,
}

impl Task for ReadLineTask {
    type Output = pipe::ReadLine;
    type JsValue = LineRead;

    fn compute(&mut self) -> Result<Self::Output> {
        self.connection
            .read_line(self.max_bytes, self.timeout)
            .map_err(|err| to_napi("read from the pipe", &err))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        let (kind, line) = match output {
            pipe::ReadLine::Line(line) => ("line", Some(line)),
            pipe::ReadLine::Closed => ("closed", None),
            pipe::ReadLine::TimedOut => ("timed_out", None),
            pipe::ReadLine::TooLong => ("too_long", None),
        };
        Ok(LineRead {
            kind: kind.to_owned(),
            line,
        })
    }
}

pub struct WriteTask {
    connection: Arc<pipe::PipeConnection>,
    bytes: Vec<u8>,
    timeout: Duration,
}

impl Task for WriteTask {
    type Output = bool;
    type JsValue = bool;

    fn compute(&mut self) -> Result<Self::Output> {
        self.connection
            .write(&self.bytes, self.timeout)
            .map_err(|err| to_napi("write to the pipe", &err))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
impl PipeConnection {
    /// Read one line of at most `max_bytes`, waiting at most `timeout_ms`.
    #[napi(ts_return_type = "Promise<LineRead>")]
    #[must_use]
    pub fn read_line(&self, max_bytes: u32, timeout_ms: u32) -> AsyncTask<ReadLineTask> {
        AsyncTask::new(ReadLineTask {
            connection: Arc::clone(&self.inner),
            max_bytes: max_bytes as usize,
            timeout: Duration::from_millis(u64::from(timeout_ms)),
        })
    }

    /// Write `text`, waiting at most `timeout_ms`. `false` when the client
    /// left or the time passed first.
    #[napi(ts_return_type = "Promise<boolean>")]
    #[must_use]
    pub fn write(&self, text: String, timeout_ms: u32) -> AsyncTask<WriteTask> {
        AsyncTask::new(WriteTask {
            connection: Arc::clone(&self.inner),
            bytes: text.into_bytes(),
            timeout: Duration::from_millis(u64::from(timeout_ms)),
        })
    }

    /// Close the connection; a pending read or write ends at once.
    #[napi]
    pub fn close(&self) {
        self.inner.close();
    }
}

/// The server end of a named pipe with an owner-only DACL.
#[napi]
pub struct PipeServer {
    inner: Arc<pipe::PipeServer>,
}

pub struct AcceptTask {
    server: Arc<pipe::PipeServer>,
}

impl Task for AcceptTask {
    type Output = Option<pipe::PipeConnection>;
    type JsValue = Option<PipeConnection>;

    fn compute(&mut self) -> Result<Self::Output> {
        self.server
            .accept()
            .map_err(|err| to_napi("accept a pipe client", &err))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.map(|connection| PipeConnection {
            inner: Arc::new(connection),
        }))
    }
}

#[napi]
impl PipeServer {
    /// Wait for the next client; `null` once the server is closed.
    #[napi(ts_return_type = "Promise<PipeConnection | null>")]
    #[must_use]
    pub fn accept(&self) -> AsyncTask<AcceptTask> {
        AsyncTask::new(AcceptTask {
            server: Arc::clone(&self.inner),
        })
    }

    /// Stop listening; a pending accept resolves `null`.
    #[napi]
    pub fn close(&self) {
        self.inner.close();
    }

    /// The pipe's owner and DACL.
    ///
    /// # Errors
    ///
    /// When the server is closed or the OS cannot read it.
    #[napi]
    pub fn security(&self) -> Result<NativeSecurity> {
        self.inner
            .security()
            .map(to_security)
            .map_err(|err| to_napi("security of the pipe", &err))
    }
}

pub struct ConnectTask {
    path: String,
    timeout: Duration,
}

impl Task for ConnectTask {
    type Output = Option<pipe::PipeConnection>;
    type JsValue = Option<PipeConnection>;

    fn compute(&mut self) -> Result<Self::Output> {
        pipe::connect(&self.path, self.timeout)
            .map_err(|err| to_napi(&format!("connect to pipe {}", self.path), &err))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.map(|connection| PipeConnection {
            inner: Arc::new(connection),
        }))
    }
}

/// Connect to the pipe at `path` as a client, waiting at most `timeout_ms`
/// for a free instance; `null` when there is no pipe, or no instance became
/// free in time.
#[napi(ts_return_type = "Promise<PipeConnection | null>")]
#[must_use]
pub fn connect_pipe(path: String, timeout_ms: u32) -> AsyncTask<ConnectTask> {
    AsyncTask::new(ConnectTask {
        path,
        timeout: Duration::from_millis(u64::from(timeout_ms)),
    })
}

/// Create the pipe at `path` (`\\.\pipe\<name>`) and its first instance.
///
/// # Errors
///
/// `Access is denied` when an instance of the name already exists.
#[napi]
pub fn create_pipe_server(path: String, reject_remote: bool) -> Result<PipeServer> {
    pipe::PipeServer::create(&path, reject_remote)
        .map(|inner| PipeServer {
            inner: Arc::new(inner),
        })
        .map_err(|err| to_napi(&format!("create pipe {path}"), &err))
}

/// What `spawnDetached` starts.
#[napi(object)]
pub struct DetachedSpawn {
    /// The executable's full path.
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    /// The whole environment.
    pub env: HashMap<String, String>,
    /// A file stdout and stderr append to; `NUL` when missing.
    pub output: Option<String>,
}

/// Start a process outside this process's job, with no console. Returns its
/// PID, or `null` when the job forbids breakaway.
///
/// # Errors
///
/// When it cannot start for another reason.
#[napi]
pub fn spawn_detached(spawn: DetachedSpawn) -> Result<Option<u32>> {
    let env: Vec<(String, String)> = spawn.env.into_iter().collect();
    detach::spawn_detached(&detach::Detached {
        program: &spawn.program,
        args: &spawn.args,
        cwd: &spawn.cwd,
        env: &env,
        output: spawn.output.as_deref(),
    })
    .map_err(|err| to_napi(&format!("start {}", spawn.program), &err))
}

/// Create a new file only the current user can open, holding `contents`.
///
/// # Errors
///
/// When the file exists or cannot be written.
#[napi]
pub fn write_private_file(path: String, contents: String) -> Result<()> {
    security::write_private_file(&path, contents.as_bytes())
        .map_err(|err| to_napi(&format!("write {path}"), &err))
}

/// The owner and DACL of a file.
///
/// # Errors
///
/// When the file is missing or its security cannot be read.
#[napi]
pub fn file_security(path: String) -> Result<NativeSecurity> {
    security::security_of_file(&path)
        .map(to_security)
        .map_err(|err| to_napi(&format!("security of {path}"), &err))
}

/// The SID of the current user.
///
/// # Errors
///
/// When the process token cannot be read.
#[napi]
pub fn current_user_sid() -> Result<String> {
    security::current_user_sid().map_err(|err| to_napi("current user", &err))
}

/// Tests only: put this process in a new kill-on-close job, with breakaway
/// rights when asked.
///
/// # Errors
///
/// When the job cannot be made or joined.
#[napi]
pub fn join_new_job(breakaway_ok: bool) -> Result<()> {
    testing::join_new_job(breakaway_ok).map_err(|err| to_napi("join a new job", &err))
}

/// Tests only: open the pipe at `path` as another local user. Returns 0, or
/// the Win32 error of the open.
///
/// # Errors
///
/// When the user cannot log on.
#[napi]
pub fn connect_pipe_as(path: String, user: String, password: String, write: bool) -> Result<u32> {
    testing::connect_pipe_as(&path, &user, &password, write)
        .map_err(|err| to_napi(&format!("log on as {user}"), &err))
}

/// The default value of `HKEY_CURRENT_USER\<key>`, or `null` when it is
/// missing.
///
/// # Errors
///
/// When the value is not a string, or the read fails.
#[napi]
pub fn read_user_registry_default(key: String) -> Result<Option<String>> {
    registry::read_user_default(&key).map_err(|err| to_napi(&format!("read HKCU\\{key}"), &err))
}

/// Tests only: open a main window (unowned, off screen, titled `title`,
/// never shown unless `visible`) that counts the close requests it gets
/// and stays open. Returns its handle.
///
/// # Errors
///
/// When the window cannot be made.
#[napi]
#[allow(clippy::cast_precision_loss, reason = "window handles fit in 53 bits")]
pub fn open_test_window(title: String, visible: bool) -> Result<f64> {
    testing::open_test_window(&title, visible)
        .map(|window| window as f64)
        .map_err(|err| to_napi("open a test window", &err))
}

/// Tests only: enable or disable a test window, as Windows disables the
/// owner of a modal dialog.
#[napi]
#[allow(
    clippy::cast_possible_truncation,
    reason = "a handle from openTestWindow"
)]
pub fn set_test_window_enabled(window: f64, enabled: bool) {
    testing::set_window_enabled(window as isize, enabled);
}

/// Tests only: how many close requests the test window got.
#[napi]
#[must_use]
pub fn test_window_close_requests() -> u32 {
    testing::close_requests()
}
