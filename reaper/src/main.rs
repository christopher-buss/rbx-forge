//! `forge-reaper`: owns every worker process of one session.
//!
//! ```text
//! forge-reaper serve --session <id> --lease <path> --record <path>
//! ```
//!
//! Takes a shared lock on the lease file, writes the reaper record (`{ pid,
//! startTime, sessionId, workers: [{ id, pid, startTime }] }`, rewritten
//! whole on each change), writes `leased`, and then speaks the protocol in
//! [`protocol`] on stdin and stdout until `terminate` or stdin EOF (see
//! [`reaper`]). It exits with the lease held and the record kept, so a
//! barrier never reads clear while the reaper still runs. Diagnostics go to stderr. The host must hold
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
use os::session;
use os::worker::{self, Inherit, Spec, WorkerTree};
use protocol::{Request, SpawnRequest};
use reaper::{Input, Platform, Reaper, RecordedWorker, Tree};

/// Exit code for a command line the reaper cannot read.
const EXIT_USAGE: u8 = 2;
/// The markers every worker carries.
const SESSION_MARKER: &str = session::SESSION_MARKER;
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

/// The reaper record file. Each write replaces the whole file (a temporary
/// file, then a rename), so a reader never sees half a record.
struct RecordFile {
    path: PathBuf,
    pid: u32,
    start_time: String,
    session: String,
}

impl RecordFile {
    fn write(&self, workers: &[RecordedWorker]) -> io::Result<()> {
        let record = serde_json::json!({
            "pid": self.pid,
            "startTime": self.start_time,
            "sessionId": self.session,
            "workers": workers,
        });
        let temporary = self.path.with_extension("json.tmp");
        std::fs::write(&temporary, record.to_string())?;
        std::fs::rename(&temporary, &self.path)
    }
}

/// Real workers for one session.
struct OsPlatform {
    session: String,
    inherit: Inherit,
    record: RecordFile,
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
            job_name: session::job_name(&self.session, serial),
        };
        WorkerTree::spawn(&spec, &self.inherit)
    }

    fn record(&mut self, workers: &[RecordedWorker]) {
        if let Err(err) = self.record.write(workers) {
            eprintln!(
                "forge-reaper: write the record {}: {err}",
                self.record.path.display()
            );
        }
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
            {
                pause("reaper-stop");
                if inputs.send(Input::StdinClosed).is_err() {
                    return;
                }
            }
        }
    });
}

/// Test-only fault injection: when
/// `RBX_FORGE_TEST_PAUSE_DIR` is set and `RBX_FORGE_TEST_PAUSE` lists
/// `point`, write `<dir>/<point>.paused` (content: the reaper's PID) and wait
/// until the test deletes it. The points:
///
/// - `reaper-lease`: before the reaper takes its lease.
/// - `reaper-stop`: at `terminate`, and when the host is gone (stdin EOF,
///   `SIGTERM`), before the reaper stops anything: a hung reaper that keeps
///   its lease and every worker. It still reaps workers that exit.
/// - `reaper-exit`: once every tree is gone and reported, just before the
///   reaper exits.
fn pause(point: &str) {
    let Some(directory) = std::env::var_os("RBX_FORGE_TEST_PAUSE_DIR") else {
        return;
    };
    let points = std::env::var("RBX_FORGE_TEST_PAUSE").unwrap_or_default();
    if !points.split(',').any(|listed| listed == point) {
        return;
    }

    let directory = PathBuf::from(directory);
    let file = directory.join(format!("{point}.paused"));
    let written = std::fs::create_dir_all(&directory)
        .and_then(|()| std::fs::write(&file, std::process::id().to_string()));
    if let Err(err) = written {
        eprintln!("forge-reaper: write {}: {err}", file.display());
        return;
    }
    while file.exists() {
        thread::sleep(std::time::Duration::from_millis(50));
    }
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

fn serve(session: &str, lease: &Path, record: &Path) -> ExitCode {
    ignore_terminal_signals();
    pause("reaper-lease");
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
            if matches!(
                protocol::parse_request(&line),
                Ok(Request::Terminate { .. })
            ) {
                pause("reaper-stop");
            }
            if stdin_sender.send(Input::Line(line)).is_err() {
                return;
            }
        }
        pause("reaper-stop");
        let _ = stdin_sender.send(Input::StdinClosed);
    });

    let pid = std::process::id();
    let start_time = match os::process::start_time(pid) {
        Ok(Some(start)) => start.to_string(),
        Ok(None) => unreachable!("the reaper itself is alive"),
        Err(err) => {
            eprintln!("forge-reaper: read its own start time: {err}");
            return ExitCode::FAILURE;
        }
    };
    let record = RecordFile {
        path: record.to_owned(),
        pid,
        start_time,
        session: session.to_owned(),
    };
    let platform = OsPlatform {
        session: session.to_owned(),
        inherit: Inherit {
            #[cfg(unix)]
            lease: Some(lock.raw_fd()),
        },
        record,
    };
    let _ = Reaper::new(platform, io::stdout(), sender).run(pid, &receiver);
    pause("reaper-exit");
    exit_holding(&lock)
}

/// Exit with the lease still held and the record still naming this
/// process: the OS releases the lease as the process ends, and a scan finds
/// the recorded reaper (PID and start time) until it has exited. So no
/// barrier reads clear while the reaper still runs.
fn exit_holding(_lease: &FileLock) -> ! {
    let _ = io::Write::flush(&mut io::stdout());
    std::process::exit(0)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match args.as_slice() {
        [
            "serve",
            "--session",
            session,
            "--lease",
            lease,
            "--record",
            record,
        ] if !session.contains('\\') => serve(session, Path::new(lease), Path::new(record)),
        ["--version"] => {
            println!("forge-reaper {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("usage: forge-reaper serve --session <id> --lease <path> --record <path>");
            ExitCode::from(EXIT_USAGE)
        }
    }
}
