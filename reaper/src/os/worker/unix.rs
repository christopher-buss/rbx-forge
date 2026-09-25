//! POSIX trees: the worker leads its own process group (`setpgid` in both
//! parent and child, so no signal can miss it). Between `fork` and `exec`
//! the child waits on a gate pipe: the reaper opens it only after it has
//! reported the worker. If the reaper dies first, the child reads EOF and
//! exits without running the program.
//!
//! The leader is not reaped until [`Tree::finish`]: an unreaped leader keeps
//! the group id from being reused, so every group signal before it reaches
//! only this tree. After the reap, the group is only probed (signal 0).

use std::ffi::{CString, c_char};
use std::fs::{File, OpenOptions};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::ptr::null;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use super::{ExitStatus, Finished, Inherit, Spec};
use crate::os::process;

/// How often [`Tree::finish`] probes the group.
const POLL_INTERVAL: Duration = Duration::from_millis(10);
/// Signals the reaper ignores; `exec` keeps an ignored signal ignored, so
/// the child restores the default first.
const RESET_SIGNALS: [libc::c_int; 5] = [
    libc::SIGHUP,
    libc::SIGINT,
    libc::SIGPIPE,
    libc::SIGQUIT,
    libc::SIGTERM,
];

#[derive(Debug)]
pub struct Tree {
    pid: libc::pid_t,
    start: u64,
    /// The write end of the gate, until release.
    gate: Mutex<Option<OwnedFd>>,
}

fn cstring(bytes: &[u8]) -> io::Result<CString> {
    CString::new(bytes).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "contains NUL"))
}

fn last_error<T>() -> io::Result<T> {
    Err(io::Error::last_os_error())
}

fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0; 2];
    // SAFETY: a two-element buffer, as `pipe` needs.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return last_error();
    }
    // SAFETY: `pipe` returned two new descriptors that nothing else owns.
    let (read, write) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
    for fd in [&read, &write] {
        // Only the main thread forks, so setting the flag after `pipe`
        // cannot leak the descriptor into another child.
        // SAFETY: plain call on an owned descriptor.
        if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
            return last_error();
        }
    }
    Ok((read, write))
}

/// Pointers into `owned`, null-terminated, for `execve`.
fn pointers(owned: &[CString]) -> Vec<*const c_char> {
    owned
        .iter()
        .map(|value| value.as_ptr())
        .chain(Some(null()))
        .collect()
}

/// Everything the child touches, prepared before `fork`: the child may only
/// make async-signal-safe calls, so it must not allocate.
struct Child<'a> {
    gate_read: RawFd,
    gate_write: RawFd,
    stdin: RawFd,
    output: RawFd,
    lease: Option<RawFd>,
    cwd: &'a CString,
    file: &'a CString,
    argv: &'a [*const c_char],
    envp: &'a [*const c_char],
}

impl Child<'_> {
    /// Runs in the forked child. Never returns.
    ///
    /// # Safety
    ///
    /// Only between `fork` and `exec`/`_exit`, in the child.
    unsafe fn exec(&self) -> ! {
        // SAFETY: async-signal-safe calls only, on prepared data.
        unsafe {
            libc::setpgid(0, 0);
            libc::close(self.gate_write);
            for signal in RESET_SIGNALS {
                libc::signal(signal, libc::SIG_DFL);
            }
            if libc::dup2(self.stdin, 0) < 0
                || libc::dup2(self.output, 1) < 0
                || libc::dup2(self.output, 2) < 0
            {
                libc::_exit(126);
            }
            if let Some(lease) = self.lease {
                libc::fcntl(lease, libc::F_SETFD, 0);
            }

            let mut byte = 0_u8;
            loop {
                let read = libc::read(self.gate_read, (&raw mut byte).cast(), 1);
                if read == 1 {
                    break;
                }
                if read < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                // EOF: the reaper died before it reported this worker.
                libc::_exit(125);
            }

            if libc::chdir(self.cwd.as_ptr()) != 0 {
                libc::_exit(127);
            }
            libc::execve(self.file.as_ptr(), self.argv.as_ptr(), self.envp.as_ptr());
            libc::_exit(127);
        }
    }
}

fn open_output(spec: &Spec) -> io::Result<File> {
    match &spec.log {
        Some(log) => OpenOptions::new().append(true).create(true).open(log),
        None => OpenOptions::new().write(true).open("/dev/null"),
    }
}

impl Tree {
    pub fn spawn(spec: &Spec, inherit: &Inherit) -> io::Result<Self> {
        let file = cstring(spec.file.as_os_str().as_bytes())?;
        // SAFETY: plain call on a valid C string.
        if unsafe { libc::access(file.as_ptr(), libc::X_OK) } != 0 {
            return last_error();
        }
        let argv_owned = std::iter::once(Ok(file.clone()))
            .chain(spec.args.iter().map(|arg| cstring(arg.as_bytes())))
            .collect::<io::Result<Vec<_>>>()?;
        let envp_owned = spec
            .env
            .iter()
            .map(|(name, value)| cstring(format!("{name}={value}").as_bytes()))
            .collect::<io::Result<Vec<_>>>()?;
        let cwd = cstring(spec.cwd.as_os_str().as_bytes())?;
        let (argv, envp) = (pointers(&argv_owned), pointers(&envp_owned));
        let stdin = File::open("/dev/null")?;
        let output = open_output(spec)?;
        let (gate_read, gate_write) = pipe()?;
        let child = Child {
            gate_read: gate_read.as_raw_fd(),
            gate_write: gate_write.as_raw_fd(),
            stdin: stdin.as_raw_fd(),
            output: output.as_raw_fd(),
            lease: inherit.lease,
            cwd: &cwd,
            file: &file,
            argv: &argv,
            envp: &envp,
        };

        // SAFETY: the child runs only `Child::exec`, which is
        // async-signal-safe.
        let pid = unsafe { libc::fork() };
        if pid < 0 {
            return last_error();
        }
        if pid == 0 {
            // SAFETY: this is the child, right after `fork`.
            unsafe { child.exec() };
        }

        // SAFETY: plain call; the child may have set its group already.
        unsafe { libc::setpgid(pid, pid) };
        drop(gate_read);
        let tree = Self {
            pid,
            start: 0,
            gate: Mutex::new(Some(gate_write)),
        };
        let pid_u32 = u32::try_from(pid).map_err(io::Error::other)?;
        match process::start_time(pid_u32) {
            Ok(Some(start)) => Ok(Self { start, ..tree }),
            // The child waits on the gate, so it cannot be gone; if the OS
            // says so anyway, give up on it. Dropping the gate ends it.
            other => {
                tree.abandon();
                Err(other
                    .err()
                    .unwrap_or_else(|| io::Error::other("the worker vanished")))
            }
        }
    }

    /// Close the gate (the child exits without `exec`) and reap the child.
    fn abandon(&self) {
        drop(self.gate.lock().expect("unpoisoned").take());
        let mut status = 0;
        // SAFETY: plain call on our own child.
        unsafe { libc::waitpid(self.pid, &mut status, 0) };
    }

    pub fn pid(&self) -> u32 {
        self.pid.cast_unsigned()
    }

    pub fn start_time(&self) -> u64 {
        self.start
    }

    pub fn release(&self) {
        let gate = self.gate.lock().expect("unpoisoned").take();
        if let Some(gate) = gate {
            // SAFETY: one byte from a valid local into an owned descriptor.
            // A failed write means the child is gone; its exit reports it.
            unsafe { libc::write(gate.as_raw_fd(), [1_u8].as_ptr().cast(), 1) };
        }
    }

    /// Signal the group. The leader is unreaped until `finish`, so the group
    /// id still names this tree.
    fn signal_group(&self, signal: libc::c_int) -> io::Result<()> {
        // SAFETY: plain call; a negative PID names the process group.
        if unsafe { libc::kill(-self.pid, signal) } != 0 {
            let err = io::Error::last_os_error();
            // No member left: nothing to signal.
            return if err.raw_os_error() == Some(libc::ESRCH) {
                Ok(())
            } else {
                Err(err)
            };
        }
        Ok(())
    }

    pub fn signal_graceful(&self) -> io::Result<()> {
        self.signal_group(libc::SIGTERM)
    }

    pub fn kill(&self) -> io::Result<()> {
        self.signal_group(libc::SIGKILL)
    }

    pub fn wait_leader(&self) -> io::Result<()> {
        loop {
            // SAFETY: all-zero is a valid value of this plain struct.
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            let id = libc::id_t::try_from(self.pid).map_err(io::Error::other)?;
            // SAFETY: plain call on our own child; `WNOWAIT` leaves it
            // unreaped.
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    id,
                    &raw mut info,
                    libc::WEXITED | libc::WNOWAIT,
                )
            };
            if result == 0 {
                return Ok(());
            }
            let err = io::Error::last_os_error();
            if err.kind() != io::ErrorKind::Interrupted {
                return Err(err);
            }
        }
    }

    fn reap(&self) -> io::Result<ExitStatus> {
        let mut status = 0;
        loop {
            // SAFETY: plain call on our own child.
            if unsafe { libc::waitpid(self.pid, &mut status, 0) } == self.pid {
                break;
            }
            let err = io::Error::last_os_error();
            if err.kind() != io::ErrorKind::Interrupted {
                return Err(err);
            }
        }

        Ok(if libc::WIFEXITED(status) {
            ExitStatus {
                code: Some(libc::WEXITSTATUS(status)),
                signal: None,
            }
        } else {
            ExitStatus {
                code: None,
                signal: Some(libc::WTERMSIG(status)),
            }
        })
    }

    /// Whether the group still has a member. Signal 0 only: after the reap
    /// the id may name another group.
    fn group_exists(&self) -> bool {
        // SAFETY: plain call; signal 0 checks without signalling.
        let found = unsafe { libc::kill(-self.pid, 0) } == 0;
        found || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }

    pub fn finish(&self, bound: Duration) -> io::Result<Finished> {
        let status = self.reap()?;
        let deadline = Instant::now() + bound;
        loop {
            if !self.group_exists() {
                return Ok(Finished {
                    status,
                    empty: true,
                });
            }
            if Instant::now() >= deadline {
                return Ok(Finished {
                    status,
                    empty: false,
                });
            }
            thread::sleep(POLL_INTERVAL);
        }
    }
}
