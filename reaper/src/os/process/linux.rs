//! Linux: the pin is a pidfd (kernel 5.3+). A pidfd keeps naming its process
//! after the PID is reaped and reused; signals through it then fail with
//! `ESRCH` instead of reaching the new process.
//!
//! `/proc/<pid>` is read by PID, so every read is followed by a pidfd check:
//! if the pinned process is still unreaped after the read, the PID cannot
//! have been reused during it.

use super::{FileId, ProcessEntry, StartTime};
use std::fs;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::PathBuf;
use std::ptr;
use std::time::{Duration, Instant};

/// Fields of `/proc/<pid>/stat`.
#[derive(Debug, Eq, PartialEq)]
struct Stat {
    /// `Z` (zombie) or `X` (dead) mean the process has exited.
    state: char,
    ppid: u32,
    group: u32,
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
    // Fields 3 to 5: state, parent, group. The start time is field 22.
    let state = fields.next()?.chars().next()?;
    let ppid = fields.next()?.parse().ok()?;
    let group = fields.next()?.parse().ok()?;
    let start = fields.nth(16)?.parse().ok()?;
    Some(Stat {
        state,
        ppid,
        group,
        start,
    })
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

pub fn processes() -> io::Result<Vec<ProcessEntry>> {
    let mut entries = Vec::new();
    for dir in fs::read_dir("/proc")? {
        let Some(pid) = dir?
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        // A process that ended since the listing has no stat left.
        if let Ok(Some(stat)) = read_stat(pid) {
            entries.push(ProcessEntry {
                pid,
                ppid: stat.ppid,
                group: stat.group,
                start_time: stat.start,
                exited: stat.has_exited() && !has_other_threads(pid),
            });
        }
    }

    Ok(entries)
}

/// Whether threads besides the main one still run. The main thread of a
/// dying multi-threaded process (Node) shows `Z` before its other threads
/// end; the parent can reap it only once they have.
fn has_other_threads(pid: u32) -> bool {
    fs::read_dir(format!("/proc/{pid}/task")).is_ok_and(|tasks| tasks.count() > 1)
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

    /// The initial environment block. A zombie's reads empty.
    pub fn environment(&self) -> io::Result<Option<Vec<u8>>> {
        let block = match fs::read(format!("/proc/{}/environ", self.pid)) {
            Ok(block) => block,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err),
        };
        // Still unreaped after the read: the PID named this process during it.
        if !self.is_unreaped()? {
            return Ok(None);
        }

        Ok(Some(block))
    }

    /// Whether a descriptor in `/proc/<pid>/fd` names `file`. Each link is
    /// followed to the open file, so a deleted or renamed path still counts.
    pub fn holds_file(&self, file: FileId) -> io::Result<Option<bool>> {
        use std::os::unix::fs::MetadataExt;
        let entries = match fs::read_dir(format!("/proc/{}/fd", self.pid)) {
            Ok(entries) => entries,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err),
        };
        let holds = entries.filter_map(Result::ok).any(|entry| {
            // A descriptor closed during the listing has no target left.
            fs::metadata(entry.path())
                .is_ok_and(|metadata| metadata.dev() == file.device && metadata.ino() == file.inode)
        });
        // Still unreaped after the read: the PID named this process during it.
        if !self.is_unreaped()? {
            return Ok(None);
        }

        Ok(Some(holds))
    }

    pub fn kill(&self) -> io::Result<bool> {
        self.signal_live(libc::SIGKILL)
    }

    pub fn request_close(&self) -> io::Result<bool> {
        self.signal_live(libc::SIGTERM)
    }

    /// Send `signal` through the pidfd unless the process has exited.
    fn signal_live(&self, signal: libc::c_int) -> io::Result<bool> {
        if self.wait(Duration::ZERO)? {
            return Ok(false);
        }

        match self.send_signal(signal) {
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
        "4242 (a) b) c) S 1 4240 4240 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 200";

    #[test]
    fn parses_the_fields_after_the_last_parenthesis() {
        assert_eq!(
            parse_stat(STAT),
            Some(Stat {
                state: 'S',
                ppid: 1,
                group: 4240,
                start: 987_654
            })
        );
    }

    #[test]
    fn rejects_a_truncated_stat() {
        assert_eq!(parse_stat("4242 (a) S 1 2"), None);
    }
}
