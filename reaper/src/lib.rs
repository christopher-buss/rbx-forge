//! `@rbx-forge/native`: the Node addon half of the crate.
//!
//! A thin napi layer over [`os`] and [`model`]: exports convert types and errors and
//! holds no logic. The TypeScript side of this surface is
//! `src/native/addon.ts`; change both together.
//!
//! Errors are thrown as JS `Error`s whose message names the call and the OS
//! error. "Not there" outcomes (a lock held by someone else, a PID with no
//! live process) are `null`, not errors.

mod model;
#[allow(dead_code, reason = "the worker layer serves only the reaper binary")]
mod os;
mod studio_dialog;
mod studio_save;
#[cfg(windows)]
mod windows_exports;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Error, Result, Task};
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

/// Read script sources in request order, using instance-name paths from the model root.
///
/// # Errors
///
/// When the model cannot be read or a path does not identify one script.
#[napi]
pub fn read_model_script_sources(
    path: String,
    script_paths: Vec<Vec<String>>,
) -> Result<Vec<String>> {
    model::read_sources(Path::new(&path), &script_paths)
        .map_err(|err| to_napi(&format!("read script sources in {path}"), &err))
}

/// Read `StringValue` values in request order, using instance-name paths from the model root.
///
/// # Errors
///
/// When the model cannot be read or a path does not identify one `StringValue`.
#[napi]
pub fn read_model_string_values(
    path: String,
    value_paths: Vec<Vec<String>>,
) -> Result<Vec<String>> {
    model::read_string_values(Path::new(&path), &value_paths)
        .map_err(|err| to_napi(&format!("read string values in {path}"), &err))
}

/// One script's replacement source, addressed from the model root.
#[napi(object)]
pub struct ModelScriptSource {
    pub path: Vec<String>,
    pub source: String,
}

/// Replace only the requested script sources, atomically preserving the original on failure.
///
/// # Errors
///
/// When a path does not identify one script or the model cannot be read or replaced.
#[napi]
pub fn write_model_script_sources(path: String, scripts: Vec<ModelScriptSource>) -> Result<()> {
    let scripts: Vec<_> = scripts
        .into_iter()
        .map(|script| (script.path, script.source))
        .collect();
    model::write_sources(Path::new(&path), &scripts)
        .map_err(|err| to_napi(&format!("write script sources in {path}"), &err))
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

/// Whether no one holds a lock on `path` now (a barrier's lease probe).
/// Takes an exclusive lock and lets go at once. Never creates the file: a
/// missing file is free.
///
/// # Errors
///
/// When the file cannot be opened or locked.
#[napi]
pub fn is_lock_free(path: String) -> Result<bool> {
    os::lock::FileLock::is_free(Path::new(&path))
        .map_err(|err| to_napi(&format!("probe the lock {path}"), &err))
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
    /// The macOS app-hidden state, or none for a nongraphical or exited process.
    ///
    /// # Errors
    ///
    /// When macOS refuses the process identity query.
    #[napi]
    pub fn app_hidden(&self) -> Result<Option<bool>> {
        self.inner
            .app_hidden()
            .map_err(|err| to_napi("read app visibility", &err))
    }

    /// Hide or unhide the macOS app without activation or a restart.
    ///
    /// # Errors
    ///
    /// When macOS refuses the process identity query.
    #[napi]
    pub fn set_app_hidden(&self, hidden: bool) -> Result<bool> {
        self.inner
            .set_app_hidden(hidden)
            .map_err(|err| to_napi("change app visibility", &err))
    }

    /// Whether the macOS app is active, or none for a nongraphical or exited process.
    ///
    /// # Errors
    ///
    /// When macOS refuses the process identity query.
    #[napi]
    pub fn app_active(&self) -> Result<Option<bool>> {
        self.inner
            .app_active()
            .map_err(|err| to_napi("read app activation", &err))
    }

    /// Unhide the macOS app and request its activation, without waiting.
    ///
    /// # Errors
    ///
    /// When macOS refuses the process identity query.
    #[napi]
    pub fn activate_app(&self) -> Result<bool> {
        self.inner
            .activate_app()
            .map_err(|err| to_napi("activate app", &err))
    }

    /// The desktop inherited by this process. Always user on POSIX.
    #[napi]
    pub fn desktop(&self) -> Result<String> {
        #[cfg(windows)]
        {
            if !self
                .inner
                .is_alive()
                .map_err(|err| to_napi("process desktop", &err))?
            {
                return Ok("user".to_owned());
            }
            let desktop = os::win::desktop::for_process(self.pid())
                .map_err(|err| to_napi("process desktop", &err))?;
            let name = desktop
                .name()
                .map_err(|err| to_napi("desktop name", &err))?;
            Ok(if name == os::win::desktop::HIDDEN_NAME {
                "hidden"
            } else {
                "user"
            }
            .to_owned())
        }
        #[cfg(not(windows))]
        {
            Ok("user".to_owned())
        }
    }

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

    /// Press Studio's English File > Save to File accessibility menu off Node's event loop.
    ///
    /// # Errors
    ///
    /// When Studio exited or the native accessibility action fails.
    #[napi]
    pub fn request_save(&self, timeout_ms: Option<u32>) -> Result<AsyncTask<StudioSaveTask>> {
        let deadline =
            Instant::now() + Duration::from_millis(u64::from(timeout_ms.unwrap_or(30_000)));
        if !self.is_alive()? {
            return Err(Error::from_reason("Studio exited"));
        }
        Ok(AsyncTask::new(StudioSaveTask {
            pid: self.pid(),
            start_time: self.inner.start_time(),
            deadline,
        }))
    }

    /// Whether Studio's File > Save to File is enabled, off Node's event loop.
    ///
    /// # Errors
    ///
    /// When Studio exited or the native accessibility query fails.
    #[napi(ts_return_type = "Promise<boolean>")]
    pub fn save_menu_enabled(&self, timeout_ms: u32) -> Result<AsyncTask<SaveMenuTask>> {
        if !self.is_alive()? {
            return Err(Error::from_reason("Studio exited"));
        }
        Ok(AsyncTask::new(SaveMenuTask {
            pid: self.pid(),
            deadline: Instant::now() + Duration::from_millis(u64::from(timeout_ms)),
        }))
    }

    /// Invoke an exact button in a dialog on the pinned process desktop.
    ///
    /// # Errors
    ///
    /// When the identity changed or Windows refuses accessibility access.
    #[napi]
    pub fn dismiss_dialog(
        &self,
        title: String,
        button: String,
        desktop: String,
        timeout_ms: Option<u32>,
    ) -> Result<AsyncTask<StudioDialogTask>> {
        Ok(AsyncTask::new(StudioDialogTask {
            pid: self.pid(),
            start_time: self.inner.start_time(),
            title,
            button,
            desktop,
            deadline: std::time::Instant::now()
                + Duration::from_millis(u64::from(timeout_ms.unwrap_or(1000))),
        }))
    }

    /// Ask the pinned process to close its main windows.
    ///
    /// # Errors
    ///
    /// When the OS refuses the request.
    #[napi]
    pub fn request_close(&self) -> Result<bool> {
        self.inner
            .request_close()
            .map_err(|err| to_napi(&format!("close process {}", self.pid()), &err))
    }

    /// Whether a modal dialog blocks the process's main windows: on Windows
    /// one of them is disabled; on macOS AX reports a modal window or sheet.
    /// `false` on Linux, without macOS Accessibility access, and after exit.
    ///
    /// # Errors
    ///
    /// When the OS refuses the query.
    #[napi]
    pub fn is_blocked(&self) -> Result<bool> {
        self.inner
            .is_blocked()
            .map_err(|err| to_napi(&format!("windows of process {}", self.pid()), &err))
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

/// One session's files: what the barrier and forced cleanup read.
#[napi(object)]
pub struct SessionTarget {
    pub session_id: String,
    /// The lease file (`workers.lock`).
    pub lease_path: String,
    /// The reaper record (`reaper.json`).
    pub record_path: String,
}

/// A live process of a session.
#[napi(object)]
pub struct SessionProcess {
    pub pid: u32,
    /// Its parent's PID (POSIX); 0 on Windows.
    pub parent_pid: u32,
    /// Its start time (see `processStartTime`).
    pub start_time: String,
    /// It is the session's reaper, as the reaper record names it.
    pub is_reaper: bool,
}

/// What a forced cleanup did.
#[napi(object)]
pub struct CleanupReport {
    /// The PIDs it killed, in kill order: leaves first, the reaper last.
    pub killed: Vec<u32>,
    /// Processes of the session still alive at the bound.
    pub survivors: Vec<u32>,
    /// Processes whose ownership could not be read again: not killed.
    pub unverifiable: Vec<u32>,
}

/// Owned copies of a [`SessionTarget`]'s paths, for a worker thread.
struct OwnedTarget {
    session: String,
    lease: PathBuf,
    record: PathBuf,
}

impl OwnedTarget {
    fn new(target: SessionTarget) -> Self {
        Self {
            session: target.session_id,
            lease: PathBuf::from(target.lease_path),
            record: PathBuf::from(target.record_path),
        }
    }

    fn borrow(&self) -> os::session::Target<'_> {
        os::session::Target {
            session: &self.session,
            lease: &self.lease,
            record: &self.record,
        }
    }
}

/// Every live process of a session: marker or lease holders (POSIX),
/// members of its jobs (Windows), and its recorded reaper. None means the
/// session's barrier is clear.
///
/// # Errors
///
/// When the OS refuses the process listing or the record cannot be read.
#[napi]
pub fn scan_session(target: SessionTarget) -> Result<Vec<SessionProcess>> {
    let target = OwnedTarget::new(target);
    os::session::scan(&target.borrow())
        .map(|members| {
            members
                .into_iter()
                .map(|member| SessionProcess {
                    pid: member.pid,
                    parent_pid: member.parent,
                    start_time: member.start_time.to_string(),
                    is_reaper: member.reaper,
                })
                .collect()
        })
        .map_err(|err| to_napi(&format!("scan session {}", target.session), &err))
}

/// Forced cleanup on a libuv worker thread, so the loop never blocks Node.
pub struct CleanupTask {
    target: OwnedTarget,
    bound: Duration,
}

impl Task for CleanupTask {
    type Output = os::session::Cleanup;
    type JsValue = CleanupReport;

    fn compute(&mut self) -> Result<Self::Output> {
        os::session::force_cleanup(&self.target.borrow(), self.bound)
            .map_err(|err| to_napi(&format!("clean up session {}", self.target.session), &err))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(CleanupReport {
            killed: output.killed,
            survivors: output.survivors,
            unverifiable: output.unverifiable,
        })
    }
}

/// Kill every process of a session within `bound_ms`: each pinned and
/// re-verified, leaves first, the reaper last. Resolves with what it did;
/// unverifiable processes are reported, never killed.
#[napi(ts_return_type = "Promise<CleanupReport>")]
#[must_use]
pub fn force_cleanup(target: SessionTarget, bound_ms: u32) -> AsyncTask<CleanupTask> {
    AsyncTask::new(CleanupTask {
        target: OwnedTarget::new(target),
        bound: Duration::from_millis(u64::from(bound_ms)),
    })
}

pub struct StudioSaveTask {
    pid: u32,
    start_time: u64,
    deadline: Instant,
}
impl Task for StudioSaveTask {
    type Output = String;
    type JsValue = String;
    fn compute(&mut self) -> Result<Self::Output> {
        if Instant::now() >= self.deadline {
            return Ok("timeout".to_owned());
        }
        let pinned = os::process::PinnedProcess::open(self.pid)
            .map_err(|err| to_napi("pin Studio for save", &err))?;
        let Some(pinned) = pinned else {
            return Err(Error::from_reason("Studio exited"));
        };
        if pinned.start_time() != self.start_time {
            return Err(Error::from_reason("Studio identity changed"));
        }
        match studio_save::request(self.pid, self.deadline) {
            _ if Instant::now() >= self.deadline => Ok("timeout".to_owned()),
            result => result.map_err(|err| to_napi("save Studio", &err)),
        }
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct SaveMenuTask {
    pid: u32,
    deadline: Instant,
}
impl Task for SaveMenuTask {
    type Output = bool;
    type JsValue = bool;
    fn compute(&mut self) -> Result<Self::Output> {
        if Instant::now() >= self.deadline {
            return Ok(false);
        }
        studio_save::save_menu_enabled(self.pid, self.deadline)
            .map_err(|err| to_napi("read Studio save menu", &err))
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// The PID of the frontmost macOS app; none elsewhere or without one.
///
/// # Errors
///
/// When AppKit is missing.
#[napi]
pub fn frontmost_application() -> Result<Option<u32>> {
    #[cfg(target_os = "macos")]
    {
        os::macos_application::frontmost().map_err(|err| to_napi("read frontmost app", &err))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(None)
    }
}

pub struct StudioDialogTask {
    pid: u32,
    start_time: u64,
    title: String,
    button: String,
    desktop: String,
    deadline: std::time::Instant,
}
impl Task for StudioDialogTask {
    type Output = bool;
    type JsValue = bool;
    fn compute(&mut self) -> Result<Self::Output> {
        let pinned = os::process::PinnedProcess::open(self.pid)
            .map_err(|err| to_napi("pin Studio for dialog", &err))?;
        let Some(pinned) = pinned else {
            return Ok(false);
        };
        if pinned.start_time() != self.start_time {
            return Ok(false);
        }
        match studio_dialog::dismiss(
            self.pid,
            &self.title,
            &self.button,
            &self.desktop,
            self.deadline,
        ) {
            _ if Instant::now() >= self.deadline => Ok(false),
            result => result.map_err(|err| to_napi("dismiss Studio dialog", &err)),
        }
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// What `launchApplication` starts.
#[cfg(target_os = "macos")]
#[napi(object)]
pub struct ApplicationLaunch {
    /// The app bundle's full path.
    pub bundle: String,
    pub args: Vec<String>,
    /// The whole environment of the new app.
    pub env: std::collections::HashMap<String, String>,
    pub activates: bool,
    pub hides: bool,
}

/// A LaunchServices launch on a libuv worker thread.
#[cfg(target_os = "macos")]
pub struct ApplicationLaunchTask {
    launch: ApplicationLaunch,
}

#[cfg(target_os = "macos")]
impl Task for ApplicationLaunchTask {
    type Output = u32;
    type JsValue = u32;
    fn compute(&mut self) -> Result<Self::Output> {
        let env: Vec<(String, String)> = self
            .launch
            .env
            .iter()
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect();
        os::macos_application::launch(&os::macos_application::Launch {
            bundle: &self.launch.bundle,
            args: &self.launch.args,
            env: &env,
            activates: self.launch.activates,
            hides: self.launch.hides,
        })
        .map_err(|err| to_napi(&format!("launch {}", self.launch.bundle), &err))
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Launch a new instance of an app bundle through LaunchServices; resolves
/// with its PID. Without `activates`, the app never becomes frontmost.
#[cfg(target_os = "macos")]
#[napi(ts_return_type = "Promise<number>")]
#[must_use]
pub fn launch_application(launch: ApplicationLaunch) -> AsyncTask<ApplicationLaunchTask> {
    AsyncTask::new(ApplicationLaunchTask { launch })
}
