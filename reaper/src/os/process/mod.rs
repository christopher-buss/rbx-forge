//! Process identity: OS start times and pinned process handles.
//!
//! A PID alone does not name a process: the OS reuses it after the process
//! is gone. A [`PinnedProcess`] holds the process itself, so every later call
//! acts on that process or reports that it has exited, never on a new process
//! with the same PID.
//!
//! | OS      | Pin                          | Start time                               |
//! | ------- | ---------------------------- | ---------------------------------------- |
//! | Windows | process handle               | creation `FILETIME` (100 ns since 1601)  |
//! | Linux   | pidfd                        | `/proc/<pid>/stat` field 22 (clock ticks since boot) |
//! | macOS   | PID + start time, re-checked | `proc_pidinfo` (microseconds since 1970) |
//!
//! macOS has no pidfd, so a pin there re-reads the start time before every
//! call. A PID reused in the microseconds between that check and the call is
//! an accepted limit (spec #28).

use std::io;
use std::path::PathBuf;
use std::time::Duration;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as sys;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as sys;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as sys;

/// When a process started, as the OS records it. Units differ per OS (see
/// the module table), so compare values only on one machine. With the PID it
/// names exactly one process.
pub type StartTime = u64;

/// Read the start time of a live process.
///
/// Returns `Ok(None)` when no live process has this PID (an exited process
/// that is not yet reaped counts as gone).
///
/// # Errors
///
/// When the OS refuses the query, for example for a process of another user.
pub fn start_time(pid: u32) -> io::Result<Option<StartTime>> {
    sys::start_time(pid)
}

/// A process held by identity. See the module docs.
#[derive(Debug)]
pub struct PinnedProcess {
    pid: u32,
    start_time: StartTime,
    pin: sys::Pin,
}

impl PinnedProcess {
    /// Pin the live process with this PID.
    ///
    /// Returns `Ok(None)` when no live process has this PID.
    ///
    /// # Errors
    ///
    /// When the OS refuses access, for example to a process of another user
    /// or an elevated process.
    pub fn open(pid: u32) -> io::Result<Option<Self>> {
        Ok(sys::Pin::open(pid)?.map(|(pin, start_time)| Self {
            pid,
            start_time,
            pin,
        }))
    }

    /// The PID the process had when it was pinned.
    #[must_use]
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// The start time read when the process was pinned.
    #[must_use]
    pub fn start_time(&self) -> StartTime {
        self.start_time
    }

    /// The full path of the process's executable.
    ///
    /// Returns `Ok(None)` when the process has exited.
    ///
    /// # Errors
    ///
    /// When the OS refuses the query.
    pub fn executable_path(&self) -> io::Result<Option<PathBuf>> {
        self.pin.executable_path()
    }

    /// Whether the pinned process still runs.
    ///
    /// # Errors
    ///
    /// When the OS refuses the query.
    pub fn is_alive(&self) -> io::Result<bool> {
        self.pin.is_alive()
    }

    /// Force-kill the pinned process (`TerminateProcess`, `SIGKILL`). Only
    /// this process: not its children, and never a process that reused its
    /// PID.
    ///
    /// Returns `Ok(false)` when the process had already exited.
    ///
    /// # Errors
    ///
    /// When the OS refuses the kill.
    pub fn kill(&self) -> io::Result<bool> {
        self.pin.kill()
    }

    /// Wait until the pinned process exits.
    ///
    /// Returns `Ok(false)` when it still runs after `timeout`.
    ///
    /// # Errors
    ///
    /// When the OS wait fails.
    pub fn wait_for_exit(&self, timeout: Duration) -> io::Result<bool> {
        self.pin.wait_for_exit(timeout)
    }
}

#[cfg(test)]
mod tests {
    use super::{PinnedProcess, start_time};
    use std::process::{Child, Command, Stdio};
    use std::time::Duration;

    /// A child that stays alive until it is killed.
    fn sleeper() -> Child {
        let mut command = if cfg!(windows) {
            let mut command = Command::new("powershell.exe");
            command.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 60"]);
            command
        } else {
            let mut command = Command::new("sleep");
            command.arg("60");
            command
        };
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }

    #[test]
    fn start_time_of_this_process_is_stable() {
        let pid = std::process::id();
        let first = start_time(pid).unwrap();

        assert!(first.is_some());
        assert_eq!(start_time(pid).unwrap(), first);
    }

    #[test]
    fn a_later_process_has_a_later_start_time() {
        let own = start_time(std::process::id()).unwrap().unwrap();
        // Linux counts start times in 10 ms clock ticks.
        std::thread::sleep(std::time::Duration::from_millis(50));
        let mut child = sleeper();
        let theirs = start_time(child.id()).unwrap().unwrap();
        child.kill().unwrap();
        child.wait().unwrap();

        assert!(theirs > own);
    }

    #[test]
    fn pin_reports_the_start_time_and_executable() {
        let pinned = PinnedProcess::open(std::process::id()).unwrap().unwrap();
        let own = std::env::current_exe().unwrap().canonicalize().unwrap();
        let path = pinned.executable_path().unwrap().unwrap();

        assert_eq!(Some(pinned.start_time()), start_time(pinned.pid()).unwrap());
        assert_eq!(path.canonicalize().unwrap(), own);
        assert!(pinned.is_alive().unwrap());
    }

    #[test]
    fn kill_ends_the_pinned_process() {
        let mut child = sleeper();
        let pinned = PinnedProcess::open(child.id()).unwrap().unwrap();

        assert!(pinned.kill().unwrap());
        assert!(pinned.wait_for_exit(Duration::from_secs(10)).unwrap());
        assert!(!pinned.is_alive().unwrap());
        child.wait().unwrap();
    }

    #[test]
    fn a_pin_on_a_reaped_process_never_signals_its_pid() {
        let mut child = sleeper();
        let pinned = PinnedProcess::open(child.id()).unwrap().unwrap();
        child.kill().unwrap();
        child.wait().unwrap();

        assert!(!pinned.is_alive().unwrap());
        assert!(!pinned.kill().unwrap());
        assert_eq!(pinned.executable_path().unwrap(), None);
    }

    #[test]
    fn wait_times_out_while_the_process_runs() {
        let mut child = sleeper();
        let pinned = PinnedProcess::open(child.id()).unwrap().unwrap();
        let exited = pinned.wait_for_exit(Duration::from_millis(50)).unwrap();
        child.kill().unwrap();
        child.wait().unwrap();

        assert!(!exited);
    }
}
