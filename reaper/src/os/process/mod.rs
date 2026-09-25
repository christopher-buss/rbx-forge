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
//! an accepted limit.

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

/// One row of the process table, read by PID: a PID in a row names the
/// process only until it is reaped. Pin it before acting on it.
#[cfg(unix)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProcessEntry {
    pub pid: u32,
    pub ppid: u32,
    /// The process group id.
    pub group: u32,
    pub start_time: StartTime,
    /// A zombie: exited, not yet reaped.
    pub exited: bool,
}

/// Every process the OS lists. Processes that end during the listing are
/// left out.
///
/// # Errors
///
/// When the OS refuses the listing.
#[cfg(unix)]
pub fn processes() -> io::Result<Vec<ProcessEntry>> {
    sys::processes()
}

/// Whether an environment block (`NAME=value` entries, each ended by NUL)
/// holds every pair exactly.
#[cfg(unix)]
fn block_contains(block: &[u8], pairs: &[(&str, &str)]) -> bool {
    pairs.iter().all(|(name, value)| {
        block.split(|byte| *byte == 0).any(|entry| {
            entry.len() == name.len() + 1 + value.len()
                && entry.starts_with(name.as_bytes())
                && entry[name.len()] == b'='
                && entry.ends_with(value.as_bytes())
        })
    })
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

    /// Ask the pinned process to close, as a user would: `WM_CLOSE` to its
    /// main windows on Windows (visible, unowned, not tool or console
    /// windows), `SIGTERM` elsewhere. The process may refuse or ask its user
    /// first; this does not wait.
    ///
    /// Returns `Ok(false)` when the process had already exited, or on
    /// Windows has no main window to close.
    ///
    /// # Errors
    ///
    /// When the OS refuses the request.
    pub fn request_close(&self) -> io::Result<bool> {
        self.pin.request_close()
    }

    /// Force-kill the process group the pinned process leads (`SIGKILL` to
    /// the group; the live leader pins the group id). Windows has no groups
    /// to kill: there it kills the process only, as [`Self::kill`].
    ///
    /// Returns `Ok(false)` when the process had already exited.
    ///
    /// # Errors
    ///
    /// When the OS refuses the kill.
    pub fn kill_group(&self) -> io::Result<bool> {
        self.pin.kill_group()
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

    /// Whether the environment the pinned process started with holds every
    /// `(name, value)` pair. A process that changes its own environment
    /// later keeps the one it started with here.
    ///
    /// Returns `Ok(None)` when the process has exited.
    ///
    /// # Errors
    ///
    /// When the OS refuses the read, for example for a process of another
    /// user.
    #[cfg(unix)]
    pub fn has_environment(&self, pairs: &[(&str, &str)]) -> io::Result<Option<bool>> {
        Ok(self
            .pin
            .environment()?
            .map(|block| block_contains(&block, pairs)))
    }

    /// Whether the pinned process has a descriptor open on `file`.
    ///
    /// Returns `Ok(None)` when the process has exited.
    ///
    /// # Errors
    ///
    /// When the OS refuses the read, for example for a process of another
    /// user.
    #[cfg(unix)]
    pub fn holds_file(&self, file: FileId) -> io::Result<Option<bool>> {
        self.pin.holds_file(file)
    }
}

/// A file by device and inode: what an open descriptor names, whatever path
/// reached it.
#[cfg(unix)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FileId {
    pub device: u64,
    pub inode: u64,
}

#[cfg(unix)]
impl FileId {
    /// The id of the file at `path`.
    ///
    /// Returns `Ok(None)` when there is no such file.
    ///
    /// # Errors
    ///
    /// When the OS refuses the query.
    pub fn of(path: &std::path::Path) -> io::Result<Option<Self>> {
        use std::os::unix::fs::MetadataExt;
        match std::fs::metadata(path) {
            Ok(metadata) => Ok(Some(Self {
                device: metadata.dev(),
                inode: metadata.ino(),
            })),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err),
        }
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

    #[cfg(unix)]
    #[test]
    fn request_close_ends_a_process_that_does_not_handle_sigterm() {
        let mut child = sleeper();
        let pinned = PinnedProcess::open(child.id()).unwrap().unwrap();

        assert!(pinned.request_close().unwrap());
        assert!(pinned.wait_for_exit(Duration::from_secs(10)).unwrap());
        child.wait().unwrap();
        assert!(!pinned.request_close().unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn request_close_skips_a_process_with_no_main_window() {
        let mut child = sleeper();
        let pinned = PinnedProcess::open(child.id()).unwrap().unwrap();
        let requested = pinned.request_close().unwrap();
        let exited = pinned.wait_for_exit(Duration::from_millis(200)).unwrap();
        child.kill().unwrap();
        child.wait().unwrap();

        assert!(!requested);
        assert!(!exited);
        assert!(!pinned.request_close().unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn request_close_posts_wm_close_to_the_main_window() {
        crate::os::win::testing::open_test_window().unwrap();
        let before = crate::os::win::testing::close_requests();
        let pinned = PinnedProcess::open(std::process::id()).unwrap().unwrap();

        assert!(pinned.request_close().unwrap());
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while crate::os::win::testing::close_requests() == before
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(crate::os::win::testing::close_requests() > before);
        assert!(pinned.is_alive().unwrap());
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

    #[cfg(unix)]
    #[test]
    fn block_contains_matches_whole_entries_only() {
        let block = b"A=1\0RBX=session\0B=\0";

        assert!(super::block_contains(
            block,
            &[("A", "1"), ("RBX", "session")]
        ));
        assert!(super::block_contains(block, &[("B", "")]));
        assert!(!super::block_contains(block, &[("A", "12")]));
        assert!(!super::block_contains(block, &[("RB", "X=session")]));
        assert!(!super::block_contains(block, &[("A", "1"), ("C", "1")]));
    }

    #[cfg(unix)]
    #[test]
    fn processes_lists_a_child_with_its_parent_group_and_start_time() {
        let mut child = sleeper();
        let entries = super::processes().unwrap();
        let entry = entries
            .iter()
            .find(|entry| entry.pid == child.id())
            .copied();
        let own_group = entries
            .iter()
            .find(|entry| entry.pid == std::process::id())
            .map(|entry| entry.group);
        let start = start_time(child.id()).unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
        let entry = entry.unwrap();

        assert_eq!(entry.ppid, std::process::id());
        assert_eq!(Some(entry.group), own_group);
        assert_eq!(Some(entry.start_time), start);
        assert!(!entry.exited);
    }

    /// Poll `has_environment` for up to five seconds until it holds `pairs`.
    #[cfg(unix)]
    fn wait_for_environment(
        pinned: &PinnedProcess,
        pairs: &[(&str, &str)],
    ) -> std::io::Result<Option<bool>> {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let found = pinned.has_environment(pairs);
            if matches!(found, Ok(Some(true))) || std::time::Instant::now() >= deadline {
                return found;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[cfg(unix)]
    #[test]
    fn has_environment_reads_the_environment_the_process_started_with() {
        let mut child = Command::new("sleep")
            .arg("60")
            .env("FORGE_TEST_MARKER", "yes")
            .stdin(Stdio::null())
            .spawn()
            .unwrap();
        let pinned = PinnedProcess::open(child.id()).unwrap().unwrap();
        // `spawn` can return while `exec` still sets up the new image, whose
        // environment reads empty until then.
        let found = wait_for_environment(&pinned, &[("FORGE_TEST_MARKER", "yes")]);
        let wrong = pinned.has_environment(&[("FORGE_TEST_MARKER", "no")]);
        child.kill().unwrap();
        child.wait().unwrap();

        assert_eq!(found.unwrap(), Some(true));
        assert_eq!(wrong.unwrap(), Some(false));
        assert_eq!(pinned.has_environment(&[]).unwrap(), None);
    }

    #[cfg(unix)]
    #[test]
    fn kill_group_ends_every_member_of_the_group() {
        use std::os::unix::process::CommandExt;

        let mut leader = Command::new("sh")
            .args(["-c", "sleep 60 & echo $!; wait"])
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        std::io::BufRead::read_line(
            &mut std::io::BufReader::new(leader.stdout.take().unwrap()),
            &mut line,
        )
        .unwrap();
        let member = PinnedProcess::open(line.trim().parse().unwrap())
            .unwrap()
            .unwrap();
        let pinned = PinnedProcess::open(leader.id()).unwrap().unwrap();

        assert!(pinned.kill_group().unwrap());
        leader.wait().unwrap();
        assert!(member.wait_for_exit(Duration::from_secs(10)).unwrap());
    }
}
