//! `@rbx-forge/native`: the Node addon half of the crate.
//!
//! A thin napi layer over [`os`]: every export converts types and errors and
//! holds no logic. The TypeScript side of this surface is
//! `src/native/addon.ts`; change both together.
//!
//! Errors are thrown as JS `Error`s whose message names the call and the OS
//! error. "Not there" outcomes (a lock held by someone else, a PID with no
//! live process) are `null`, not errors.

#[allow(dead_code, reason = "the worker layer serves only the reaper binary")]
mod os;
#[cfg(windows)]
mod windows_exports;

use std::path::Path;
use std::time::Duration;

use napi::{Error, Result};
use napi_derive::napi;

fn to_napi(context: &str, err: &std::io::Error) -> Error {
    Error::from_reason(format!("{context}: {err}"))
}

/// Version of the native crate, so the JS side can check it loaded the
/// matching build.
#[napi]
#[must_use]
pub fn native_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

/// Start time of a live process as a decimal string, or `null` when no live
/// process has this PID. Units differ per OS: compare values for equality
/// (and order) only on one machine.
///
/// # Errors
///
/// When the OS refuses the query.
#[napi]
pub fn process_start_time(pid: u32) -> Result<Option<String>> {
    os::process::start_time(pid)
        .map(|start| start.map(|value| value.to_string()))
        .map_err(|err| to_napi(&format!("start time of process {pid}"), &err))
}

/// How a lock shares its file.
#[napi(string_enum = "lowercase")]
pub enum LockMode {
    Exclusive,
    Shared,
}

/// A held file lock. The OS releases it when the process dies, when
/// `release` runs, or when the object is garbage collected.
#[napi]
pub struct FileLock {
    inner: Option<os::lock::FileLock>,
}

#[napi]
impl FileLock {
    /// Release the lock. Safe to call more than once.
    #[napi]
    pub fn release(&mut self) {
        self.inner = None;
    }
}

/// Take a lock on `path` without waiting; creates the file when missing.
/// Returns `null` when another holder's lock conflicts.
///
/// # Errors
///
/// When the file cannot be opened or locked.
#[napi]
pub fn try_lock_file(path: String, mode: LockMode) -> Result<Option<FileLock>> {
    let mode = match mode {
        LockMode::Exclusive => os::lock::LockMode::Exclusive,
        LockMode::Shared => os::lock::LockMode::Shared,
    };
    os::lock::FileLock::try_acquire(Path::new(&path), mode)
        .map(|lock| lock.map(|inner| FileLock { inner: Some(inner) }))
        .map_err(|err| to_napi(&format!("lock {path}"), &err))
}

/// A process held by identity (Windows handle, Linux pidfd, macOS PID and
/// start time). Every method acts on the pinned process or reports that it
/// exited; none reaches a process that reused the PID.
#[napi]
pub struct PinnedProcess {
    inner: os::process::PinnedProcess,
}

#[napi]
impl PinnedProcess {
    /// The PID the process had when it was pinned.
    #[napi(getter)]
    #[must_use]
    pub fn pid(&self) -> u32 {
        self.inner.pid()
    }

    /// The start time read when the process was pinned (see
    /// `processStartTime`).
    #[napi(getter)]
    #[must_use]
    pub fn start_time(&self) -> String {
        self.inner.start_time().to_string()
    }

    /// Full path of the executable, or `null` once the process has exited.
    ///
    /// # Errors
    ///
    /// When the OS refuses the query.
    #[napi]
    pub fn executable_path(&self) -> Result<Option<String>> {
        self.inner
            .executable_path()
            .map(|path| path.map(|path| path.to_string_lossy().into_owned()))
            .map_err(|err| to_napi(&format!("executable of process {}", self.pid()), &err))
    }

    /// Whether the pinned process still runs.
    ///
    /// # Errors
    ///
    /// When the OS refuses the query.
    #[napi]
    pub fn is_alive(&self) -> Result<bool> {
        self.inner
            .is_alive()
            .map_err(|err| to_napi(&format!("state of process {}", self.pid()), &err))
    }

    /// Force-kill the pinned process only (not its children). `false` when
    /// it had already exited.
    ///
    /// # Errors
    ///
    /// When the OS refuses the kill.
    #[napi]
    pub fn kill(&self) -> Result<bool> {
        self.inner
            .kill()
            .map_err(|err| to_napi(&format!("kill process {}", self.pid()), &err))
    }

    /// Force-kill the process group the pinned process leads (POSIX). On
    /// Windows, where jobs own trees, it kills the process only. `false`
    /// when it had already exited.
    ///
    /// # Errors
    ///
    /// When the OS refuses the kill.
    #[napi]
    pub fn kill_group(&self) -> Result<bool> {
        self.inner
            .kill_group()
            .map_err(|err| to_napi(&format!("kill group of process {}", self.pid()), &err))
    }

    /// Block until the process exits or `timeout_ms` passes. `true` once it
    /// has exited.
    ///
    /// # Errors
    ///
    /// When the OS wait fails.
    #[napi]
    pub fn wait_for_exit(&self, timeout_ms: u32) -> Result<bool> {
        self.inner
            .wait_for_exit(Duration::from_millis(u64::from(timeout_ms)))
            .map_err(|err| to_napi(&format!("wait for process {}", self.pid()), &err))
    }
}

/// Pin the live process with this PID, or `null` when there is none.
///
/// # Errors
///
/// When the OS refuses access (another user's or an elevated process).
#[napi]
pub fn pin_process(pid: u32) -> Result<Option<PinnedProcess>> {
    os::process::PinnedProcess::open(pid)
        .map(|pinned| pinned.map(|inner| PinnedProcess { inner }))
        .map_err(|err| to_napi(&format!("pin process {pid}"), &err))
}
