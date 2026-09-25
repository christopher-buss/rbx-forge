//! `forge-reaper`: owns every worker process of one session.
//!
//! ```text
//! forge-reaper serve --session <id> --lease <path>
//! ```
//!
//! Takes a shared lock on the lease file, writes `leased`, and then speaks
//! the protocol in [`protocol`] on stdin and stdout until `terminate` or
//! stdin EOF (see [`reaper`]). Diagnostics go to stderr. The host must hold
//! the only write end of stdin: its EOF is how the reaper learns that the
//! host died. On POSIX, `SIGTERM` means the same; on Linux the reaper also
//! asks for it as its parent-death signal, and is a child subreaper (see
//! [`os::worker::become_owner`]).
//!
//! It compiles the same `os` module tree as the addon, without napi, so the
//! `os` tests run through this target (`cargo test`).

#[allow(dead_code, reason = "the addon uses the rest of the os layer")]
mod os;
mod protocol;
mod reaper;

use std::io::{self, BufRead};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::mpsc;
use std::thread;

use os::lock::{FileLock, LockMode};
use os::worker::{self, Inherit, Spec, WorkerTree};
use protocol::SpawnRequest;
use reaper::{Input, Platform, Reaper, Tree};

/// Exit code for a command line the reaper cannot read.
const EXIT_USAGE: u8 = 2;
/// The markers every worker carries (spec #28).
const SESSION_MARKER: &str = "RBX_FORGE_SESSION";
const WORKER_MARKER: &str = "RBX_FORGE_WORKER";

impl Tree for WorkerTree {
    fn pid(&self) -> u32 {
        WorkerTree::pid(self)
    }
    fn start_time(&self) -> u64 {
        WorkerTree::start_time(self)
    }
    fn release(&self) {
        WorkerTree::release(self);
    }
    fn signal_graceful(&self) -> io::Result<()> {
        WorkerTree::signal_graceful(self)
    }
    fn kill(&self) -> io::Result<()> {
        WorkerTree::kill(self)
    }
    fn wait_leader(&self) -> io::Result<()> {
        WorkerTree::wait_leader(self)
    }
    fn finish(&self, bound: std::time::Duration) -> io::Result<reaper::Finished> {
        WorkerTree::finish(self, bound)
    }
}

/// Real workers for one session.
struct OsPlatform {
    session: String,
    inherit: Inherit,
}

impl Platform for OsPlatform {
    type Tree = WorkerTree;

    fn spawn(&mut self, serial: u64, request: &SpawnRequest) -> io::Result<WorkerTree> {
        let mut env: Vec<(String, String)> = request
            .env
            .iter()
            .filter(|(name, _)| !is_marker(name))
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect();
        let markers = vec![
            (SESSION_MARKER.to_owned(), self.session.clone()),
            (WORKER_MARKER.to_owned(), request.id.clone()),
        ];
        env.extend(markers.iter().cloned());

        let spec = Spec {
            file: PathBuf::from(&request.file),
            args: request.args.clone(),
            cwd: PathBuf::from(&request.cwd),
            env,
            markers,
            log: request.log.as_ref().map(PathBuf::from),
            verbatim: request.verbatim,
            job_name: format!("Local\\rbx-forge-{}-{serial}", self.session),
        };
        WorkerTree::spawn(&spec, &self.inherit)
    }

    fn sweep_orphans(&mut self) {
        match worker::sweep_orphans(reaper::CONFIRM_BOUND) {
            Ok(survivors) if survivors.is_empty() => {}
            Ok(survivors) => eprintln!("forge-reaper: orphans outlived the sweep: {survivors:?}"),
            Err(err) => eprintln!("forge-reaper: sweep orphans: {err}"),
        }
    }
}

/// POSIX: turn `SIGTERM` into the host-gone input, so a `SIGTERM` (on
/// Linux also the parent-death signal) stops every tree before the reaper
/// exits. `SIGTERM` is blocked in this thread before any other thread
/// starts, so every thread inherits the block and only the waiting thread
/// takes it. Workers unblock it before `exec`.
#[cfg(unix)]
fn watch_sigterm(inputs: mpsc::Sender<Input>) {
    // SAFETY: all-zero is a valid `sigset_t` for `sigemptyset` to fill.
    let mut set: libc::sigset_t = unsafe { std::mem::zeroed() };
    // SAFETY: a valid local set; plain calls.
    unsafe {
        libc::sigemptyset(&raw mut set);
        libc::sigaddset(&raw mut set, libc::SIGTERM);
        libc::pthread_sigmask(libc::SIG_BLOCK, &raw const set, std::ptr::null_mut());
    }
    thread::spawn(move || {
        loop {
            let mut signal = 0;
            // SAFETY: a valid set and output.
            if unsafe { libc::sigwait(&raw const set, &raw mut signal) } == 0
                && signal == libc::SIGTERM
                && inputs.send(Input::StdinClosed).is_err()
            {
                return;
            }
        }
    });
}

/// Whether a variable is a marker. Windows names ignore case.
fn is_marker(name: &str) -> bool {
    [SESSION_MARKER, WORKER_MARKER]
        .iter()
        .any(|marker| name.eq_ignore_ascii_case(marker))
}

/// Terminal signals must not end the reaper: only stdin EOF and `terminate`
/// do, so it always cleans up.
fn ignore_terminal_signals() {
    #[cfg(unix)]
    for signal in [libc::SIGINT, libc::SIGHUP, libc::SIGQUIT] {
        // SAFETY: plain call; ignoring a signal is always valid.
        unsafe { libc::signal(signal, libc::SIG_IGN) };
    }

    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;
        unsafe extern "system" fn ignore(_event: u32) -> windows_sys::core::BOOL {
            1
        }
        // SAFETY: a valid handler for the life of the process.
        unsafe { SetConsoleCtrlHandler(Some(ignore), 1) };
    }
}

fn serve(session: &str, lease: &Path) -> ExitCode {
    ignore_terminal_signals();
    let lock = match FileLock::try_acquire(lease, LockMode::Shared) {
        Ok(Some(lock)) => lock,
        Ok(None) => {
            eprintln!(
                "forge-reaper: the lease {} is held exclusively",
                lease.display()
            );
            return ExitCode::FAILURE;
        }
        Err(err) => {
            eprintln!("forge-reaper: lock the lease {}: {err}", lease.display());
            return ExitCode::FAILURE;
        }
    };

    let (sender, receiver) = mpsc::channel();
    // Before the first thread starts: see `watch_sigterm`.
    #[cfg(unix)]
    watch_sigterm(sender.clone());
    if let Err(err) = worker::become_owner() {
        eprintln!("forge-reaper: take ownership of descendants: {err}");
        return ExitCode::FAILURE;
    }
    let stdin_sender = sender.clone();
    thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if stdin_sender.send(Input::Line(line)).is_err() {
                return;
            }
        }
        let _ = stdin_sender.send(Input::StdinClosed);
    });

    let platform = OsPlatform {
        session: session.to_owned(),
        inherit: Inherit {
            #[cfg(unix)]
            lease: Some(lock.raw_fd()),
        },
    };
    Reaper::new(platform, io::stdout(), sender).run(std::process::id(), &receiver);
    // The lease ends here for the reaper; workers that inherited it (POSIX)
    // hold it until they exit.
    drop(lock);
    ExitCode::SUCCESS
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match args.as_slice() {
        ["serve", "--session", session, "--lease", lease] if !session.contains('\\') => {
            serve(session, Path::new(lease))
        }
        ["--version"] => {
            println!("forge-reaper {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("usage: forge-reaper serve --session <id> --lease <path>");
            ExitCode::from(EXIT_USAGE)
        }
    }
}
