//! POSIX trees: the worker leads its own process group (`setpgid` in both
//! parent and child, so no signal can miss it). Between `fork` and `exec`
//! the child waits on a gate pipe: the reaper opens it only after it has
//! reported the worker. If the reaper dies first, the child reads EOF and
//! exits without running the program.
//!
//! The leader is not reaped until [`Tree::finish`]: an unreaped leader keeps
//! the group id from being reused, so every group signal before it reaches
//! only this tree. No group is signalled after its leader's reap.
//!
//! Forced stop ([`Tree::finish`]) is the discover–kill loop:
//! every pass signals the group, then lists the process table and kills
//! each process outside the group that carries the worker's markers. Such a
//! process is killed only through a pin (Linux pidfd; macOS start-time
//! check), after the pinned process shows the start time the listing saw
//! and every marker, so a reused PID never receives the kill. Nothing
//! is reaped during the loop: the leader's zombie pins the group id, and
//! adopted zombies pin their PIDs. The loop is bounded; it reports its
//! survivors instead of hanging.

use std::ffi::{CString, c_char};
use std::fs::{File, OpenOptions};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::ptr::null;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use super::converge::converge;
use super::{ExitStatus, Finished, Inherit, Spec};
use crate::os::process::{self, PinnedProcess, ProcessEntry};

/// Pause between two passes of the discover–kill loop.
const POLL_INTERVAL: Duration = Duration::from_millis(10);
/// Leaders not yet reaped. Only their own tree reaps them; every other
/// child of the reaper is an adopted orphan.
static LEADERS: Mutex<Vec<libc::pid_t>> = Mutex::new(Vec::new());
/// Set by [`become_owner`]. Only then is every other child of this process
/// an orphan it adopted; in a test process, other children are the tests'.
static OWNER: AtomicBool = AtomicBool::new(false);
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
    markers: Vec<(String, String)>,
}

fn leaders() -> std::sync::MutexGuard<'static, Vec<libc::pid_t>> {
    LEADERS.lock().expect("unpoisoned")
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
    /// No blocked signal: the reaper blocks `SIGTERM` (see `main.rs`), and
    /// `exec` keeps the mask.
    unblocked: &'a libc::sigset_t,
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
            libc::pthread_sigmask(libc::SIG_SETMASK, self.unblocked, std::ptr::null_mut());
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
        // SAFETY: all-zero is a valid `sigset_t` for `sigemptyset` to fill.
        let mut unblocked: libc::sigset_t = unsafe { std::mem::zeroed() };
        // SAFETY: a valid local set.
        unsafe { libc::sigemptyset(&raw mut unblocked) };
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
            unblocked: &unblocked,
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

        // Only the reaper's main thread forks and reaps adopted orphans, so
        // no reap can pass between the fork and this registration.
        leaders().push(pid);
        // SAFETY: plain call; the child may have set its group already.
        unsafe { libc::setpgid(pid, pid) };
        drop(gate_read);
        let tree = Self {
            pid,
            start: 0,
            gate: Mutex::new(Some(gate_write)),
            markers: spec.markers.clone(),
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
        leaders().retain(|leader| *leader != self.pid);
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
        leaders().retain(|leader| *leader != self.pid);

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

    /// One pass of the loop: kill the group and every marked process
    /// outside it. `killed` keeps the pins of earlier kills across passes.
    /// Returns the PIDs that were alive.
    fn pass(&self, killed: &mut Vec<PinnedProcess>) -> io::Result<Vec<u32>> {
        // The leader is unreaped: the group id still names this tree.
        if let Err(err) = self.signal_group(libc::SIGKILL) {
            eprintln!("forge-reaper: kill group {}: {err}", self.pid);
        }
        let markers: Vec<(&str, &str)> = self
            .markers
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect();
        let own = std::process::id();
        let group = self.pid();
        let mut alive = Vec::new();
        for entry in process::processes()? {
            if entry.exited || entry.pid == own {
                continue;
            }
            // A group member dies from the group signal; a process that
            // started before the leader cannot descend from it.
            if entry.group == group {
                alive.push(entry.pid);
            } else if entry.start_time >= self.start
                && !killed.iter().any(|pin| pin.pid() == entry.pid)
                && let Some(pin) = kill_marked(&entry, &markers)
            {
                killed.push(pin);
            }
        }
        // Killed through a pin: alive until the pin sees the exit.
        killed.retain(|pin| pin.is_alive().unwrap_or(false));
        alive.extend(killed.iter().map(PinnedProcess::pid));

        Ok(alive)
    }

    pub fn finish(&self, bound: Duration) -> io::Result<Finished> {
        let mut killed = Vec::new();
        let swept = converge(|| self.pass(&mut killed), bound, POLL_INTERVAL);
        let status = self.reap()?;
        reap_adopted();
        let survivors = swept?;
        Ok(Finished {
            status,
            empty: survivors.is_empty(),
            survivors,
        })
    }
}

/// Kill a process outside the group that carries every marker. Only
/// through a pin, and only when the pinned process has the start time the
/// listing saw (else the PID now names another process) and every marker.
/// A process the reaper cannot inspect (another user's) is never killed.
///
/// Returns the pin of a process it killed: the process counts as alive
/// until the pin sees it gone, as a dying multi-threaded process can no
/// longer show its markers.
pub(super) fn kill_marked(entry: &ProcessEntry, markers: &[(&str, &str)]) -> Option<PinnedProcess> {
    if markers.is_empty() {
        return None;
    }

    let verified_kill = || -> io::Result<Option<PinnedProcess>> {
        let Some(pin) = PinnedProcess::open(entry.pid)? else {
            return Ok(None);
        };
        if pin.start_time() != entry.start_time || pin.has_environment(markers)? != Some(true) {
            return Ok(None);
        }

        Ok(pin.kill()?.then_some(pin))
    };
    verified_kill().ok().flatten()
}

/// Reap every exited child that is not a live worker's leader: orphans the
/// Linux subreaper adopted. Called only between loops, never during one.
fn reap_adopted() {
    if !OWNER.load(Ordering::Relaxed) {
        return;
    }
    let own = std::process::id();
    let Ok(entries) = process::processes() else {
        return;
    };
    let leaders = leaders();
    for entry in entries {
        let Ok(pid) = libc::pid_t::try_from(entry.pid) else {
            continue;
        };
        if entry.ppid == own && entry.exited && !leaders.contains(&pid) {
            let mut status = 0;
            // SAFETY: plain call on our own exited child.
            unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        }
    }
}

/// See [`super::sweep_orphans`].
pub fn sweep_orphans(bound: Duration) -> io::Result<Vec<u32>> {
    if !OWNER.load(Ordering::Relaxed) {
        return Ok(Vec::new());
    }
    let own = std::process::id();
    let swept = converge(
        || {
            let leaders = leaders().clone();
            let mut alive = Vec::new();
            for entry in process::processes()? {
                let is_leader =
                    libc::pid_t::try_from(entry.pid).is_ok_and(|pid| leaders.contains(&pid));
                if entry.ppid != own || entry.exited || is_leader {
                    continue;
                }
                // An unreaped child: its PID cannot be reused, so the pin
                // names this process. One whose main thread already exited
                // cannot be pinned; it is dying and counts until it is gone.
                if let Ok(Some(pin)) = PinnedProcess::open(entry.pid) {
                    let _ = pin.kill();
                }
                alive.push(entry.pid);
            }
            Ok(alive)
        },
        bound,
        POLL_INTERVAL,
    );
    reap_adopted();
    swept
}

/// Linux: become a child subreaper and get `SIGTERM` when the parent dies.
/// `PR_SET_PDEATHSIG` fires when the parent *thread* that spawned the
/// reaper ends; Node spawns from its main thread, which lives as long as
/// the host. A parent that died before this call is seen as stdin EOF.
#[cfg(target_os = "linux")]
pub fn become_owner() -> io::Result<()> {
    let settings: [(libc::c_int, libc::c_ulong); 2] = [
        (libc::PR_SET_CHILD_SUBREAPER, 1),
        (
            libc::PR_SET_PDEATHSIG,
            libc::c_ulong::try_from(libc::SIGTERM).map_err(io::Error::other)?,
        ),
    ];
    for (option, value) in settings {
        // SAFETY: plain call with integer arguments.
        if unsafe { libc::prctl(option, value, 0, 0, 0) } != 0 {
            return last_error();
        }
    }
    OWNER.store(true, Ordering::Relaxed);

    Ok(())
}

/// macOS has no subreaper or parent-death signal: stdin EOF alone tells the
/// reaper that the host died, and the marker scan finds orphans.
#[cfg(not(target_os = "linux"))]
pub fn become_owner() -> io::Result<()> {
    OWNER.store(true, Ordering::Relaxed);
    Ok(())
}
