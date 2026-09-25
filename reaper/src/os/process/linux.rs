//! Linux: the pin is a pidfd (kernel 5.3+). A pidfd keeps naming its process
//! after the PID is reaped and reused; signals through it then fail with
//! `ESRCH` instead of reaching the new process.
//!
//! `/proc/<pid>` is read by PID, so every read is followed by a pidfd check:
//! if the pinned process is still unreaped after the read, the PID cannot
//! have been reused during it.

use super::StartTime;
use std::fs;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::PathBuf;
use std::ptr;
use std::time::{Duration, Instant};

/// State and start time from `/proc/<pid>/stat`.
#[derive(Debug, Eq, PartialEq)]
struct Stat {
    /// `Z` (zombie) or `X` (dead) mean the process has exited.
    state: char,
    start: StartTime,
}

impl Stat {
    fn has_exited(&self) -> bool {
        matches!(self.state, 'Z' | 'X')
    }
}

/// Parse `/proc/<pid>/stat`. The command name (field 2) is in parentheses and
/// may hold spaces and `)`, so fields are counted from the last `)`.
fn parse_stat(text: &str) -> Option<Stat> {
    let rest = &text[text.rfind(')')? + 1..];
    let mut fields = rest.split_whitespace();
    let state = fields.next()?.chars().next()?;
    // Field 3 is the state; the start time is field 22.
    let start = fields.nth(18)?.parse().ok()?;
    Some(Stat { state, start })
}

/// Read a process's stat. `Ok(None)` when no process has this PID.
fn read_stat(pid: u32) -> io::Result<Option<Stat>> {
    match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(text) => parse_stat(&text)
            .map(Some)
            .ok_or_else(|| io::Error::other(format!("unreadable /proc/{pid}/stat"))),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}

pub fn start_time(pid: u32) -> io::Result<Option<StartTime>> {
    Ok(read_stat(pid)?
        .filter(|stat| !stat.has_exited())
        .map(|stat| stat.start))
}

/// A pidfd, closed on drop.
#[derive(Debug)]
pub struct Pin {
    fd: OwnedFd,
    pid: u32,
}

impl Pin {
    pub fn open(pid: u32) -> io::Result<Option<(Self, StartTime)>> {
        let raw_pid = libc::pid_t::try_from(pid).map_err(io::Error::other)?;
        // SAFETY: plain syscall; the result is checked below.
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, raw_pid, 0) };
        if fd < 0 {
            let err = io::Error::last_os_error();
            return if err.raw_os_error() == Some(libc::ESRCH) {
                Ok(None)
            } else {
                Err(err)
            };
        }

        let fd = i32::try_from(fd).map_err(io::Error::other)?;
        // SAFETY: `pidfd_open` returned a new descriptor that nothing else owns.
        let pin = Self {
            fd: unsafe { OwnedFd::from_raw_fd(fd) },
            pid,
        };
        let Some(stat) = read_stat(pid)? else {
            return Ok(None);
        };
        if stat.has_exited() || !pin.is_unreaped()? {
            return Ok(None);
        }

        Ok(Some((pin, stat.start)))
    }

    /// Whether the pinned process is still unreaped (running or zombie), so
    /// its PID still names it.
    fn is_unreaped(&self) -> io::Result<bool> {
        match self.send_signal(0) {
            Ok(()) => Ok(true),
            Err(err) if err.raw_os_error() == Some(libc::ESRCH) => Ok(false),
            Err(err) => Err(err),
        }
    }

    fn send_signal(&self, signal: libc::c_int) -> io::Result<()> {
        // SAFETY: plain syscall on an owned pidfd; no siginfo.
        let result = unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                self.fd.as_raw_fd(),
                signal,
                ptr::null::<libc::siginfo_t>(),
                0,
            )
        };
        if result < 0 {
            return Err(io::Error::last_os_error());
        }

        Ok(())
    }

    /// Wait until the pidfd reports the exit. `Ok(true)` once it has.
    fn wait(&self, timeout: Duration) -> io::Result<bool> {
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let millis = libc::c_int::try_from(left.as_millis()).unwrap_or(libc::c_int::MAX);
            let mut poll = libc::pollfd {
                fd: self.fd.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: one valid pollfd.
            let ready = unsafe { libc::poll(&mut poll, 1, millis) };
            if ready > 0 {
                return Ok(true);
            }
            if ready == 0 {
                return Ok(false);
            }

            let err = io::Error::last_os_error();
            if err.kind() != io::ErrorKind::Interrupted {
                return Err(err);
            }
        }
    }

    pub fn executable_path(&self) -> io::Result<Option<PathBuf>> {
        let path = match fs::read_link(format!("/proc/{}/exe", self.pid)) {
            Ok(path) => path,
            // A zombie or a reaped process has no executable link.
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err),
        };
        if self.wait(Duration::ZERO)? || !self.is_unreaped()? {
            return Ok(None);
        }

        Ok(Some(path))
    }

    pub fn is_alive(&self) -> io::Result<bool> {
        Ok(!self.wait(Duration::ZERO)?)
    }

    pub fn kill(&self) -> io::Result<bool> {
        if self.wait(Duration::ZERO)? {
            return Ok(false);
        }

        match self.send_signal(libc::SIGKILL) {
            Ok(()) => Ok(true),
            Err(err) if err.raw_os_error() == Some(libc::ESRCH) => Ok(false),
            Err(err) => Err(err),
        }
    }

    pub fn kill_group(&self) -> io::Result<bool> {
        if self.wait(Duration::ZERO)? {
            return Ok(false);
        }

        let raw_pid = libc::pid_t::try_from(self.pid).map_err(io::Error::other)?;
        // SAFETY: plain call. The pidfd shows the leader unreaped, so the
        // group id still names its group.
        if unsafe { libc::kill(-raw_pid, libc::SIGKILL) } != 0 {
            let err = io::Error::last_os_error();
            return if err.raw_os_error() == Some(libc::ESRCH) {
                Ok(false)
            } else {
                Err(err)
            };
        }

        Ok(true)
    }

    pub fn wait_for_exit(&self, timeout: Duration) -> io::Result<bool> {
        self.wait(timeout)
    }
}

#[cfg(test)]
mod tests {
    use super::{Stat, parse_stat};

    const STAT: &str =
        "4242 (a) b) c) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 200";

    #[test]
    fn parses_the_state_and_start_time_after_the_last_parenthesis() {
        assert_eq!(
            parse_stat(STAT),
            Some(Stat {
                state: 'S',
                start: 987_654
            })
        );
    }

    #[test]
    fn rejects_a_truncated_stat() {
        assert_eq!(parse_stat("4242 (a) S 1 2"), None);
    }
}
