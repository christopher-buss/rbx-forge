//! The reaper core: the protocol state machine, free of OS calls.
//!
//! [`Reaper::run`] reads [`Input`]s from one channel: request lines from the
//! stdin thread, stdin EOF, and leader exits from one waiter thread per
//! worker. It writes [`Event`]s to the host. The OS work (jobs, process
//! groups, signals) sits behind [`Platform`] and [`Tree`], so tests drive the
//! state machine with a fake.
//!
//! Rules:
//!
//! - Nothing spawns before `go`. `go` after `terminate` is ignored.
//! - `terminate` is irreversible: every later `spawn` is rejected; every
//!   worker gets the stop sequence; once all trees are empty the reaper
//!   writes `terminated` and returns, which releases the lease.
//! - stdin EOF means the host is gone: the same end, with a forced kill and
//!   no grace.
//! - Stop sequence per worker: graceful signal, then a forced kill of the
//!   whole tree when `graceMs` runs out. Once the leader exits, whatever is
//!   left of its tree is killed, emptiness is confirmed within a bound, and
//!   `exited` is written.
//! - The reaper record names every live worker: it is written before
//!   `leased`, after each `spawned`, and before each `exited` (see
//!   [`Platform::record`]).

use std::io::{self, Write};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

pub use crate::os::worker::{ExitStatus, Finished};
use crate::protocol::{
    Event, FinalReport, RejectReason, Report, Request, SpawnRequest, encode_event, parse_request,
};

/// How long the reaper waits for a killed tree to empty before it reports
/// the worker as `incomplete`.
pub const CONFIRM_BOUND: Duration = Duration::from_secs(5);

/// One worker's process tree: a job (Windows) or a process group (POSIX).
pub trait Tree: Send + Sync + 'static {
    fn pid(&self) -> u32;
    /// OS start time of the leader (see `os::process`).
    fn start_time(&self) -> u64;
    /// Let the leader run. Called once `spawned` is written, so the host
    /// knows every worker before it runs code.
    fn release(&self);
    /// Ask the tree to stop (`CTRL_BREAK`, `SIGTERM` to the group).
    fn signal_graceful(&self) -> io::Result<()>;
    /// Kill the whole tree. Only before [`Tree::finish`].
    fn kill(&self) -> io::Result<()>;
    /// Block until the leader exits. Does not reap it.
    fn wait_leader(&self) -> io::Result<()>;
    /// After the leader exited: reap it and wait up to `bound` for the tree
    /// to be empty.
    fn finish(&self, bound: Duration) -> io::Result<Finished>;
}

/// One live worker, as the reaper record names it.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedWorker {
    pub id: String,
    pub pid: u32,
    /// OS start time of the leader, as in `spawned`.
    pub start_time: String,
    /// Names its Windows job (`os::session::job_name`).
    pub serial: u64,
}

/// Creates trees.
pub trait Platform {
    type Tree: Tree;
    /// Create the worker, held so it runs no code until [`Tree::release`].
    fn spawn(&mut self, serial: u64, request: &SpawnRequest) -> io::Result<Self::Tree>;
    /// The live workers are now `workers`: keep the reaper record current,
    /// so a cleanup can find them when the reaper hangs.
    fn record(&mut self, workers: &[RecordedWorker]);
    /// Once every tree is finished, before `terminated`: kill what no tree
    /// names (Linux: orphans the subreaper adopted).
    fn sweep_orphans(&mut self);
}

/// What the main loop reacts to.
#[derive(Debug)]
pub enum Input {
    /// One line from stdin.
    Line(String),
    /// The host is gone: stdin reached EOF or failed, or `SIGTERM` arrived
    /// (POSIX; on Linux also the parent-death signal).
    StdinClosed,
    /// The leader of the worker with this serial exited.
    LeaderExited(u64),
}

struct Worker<T> {
    serial: u64,
    id: String,
    tree: Arc<T>,
    /// When the forced kill is due, while a stop is under way.
    deadline: Option<Instant>,
    forced: bool,
}

/// The state machine. See the module docs.
pub struct Reaper<P: Platform, W: Write> {
    platform: P,
    out: W,
    inputs: Sender<Input>,
    admitted: bool,
    terminating: bool,
    next_serial: u64,
    workers: Vec<Worker<P::Tree>>,
    reports: Vec<FinalReport>,
}

impl<P: Platform, W: Write> Reaper<P, W> {
    /// `inputs` is the sending half of the channel [`Reaper::run`] reads;
    /// waiter threads report leader exits through it.
    pub fn new(platform: P, out: W, inputs: Sender<Input>) -> Self {
        Self {
            platform,
            out,
            inputs,
            admitted: false,
            terminating: false,
            next_serial: 0,
            workers: Vec::new(),
            reports: Vec::new(),
        }
    }

    /// Write `leased`, then run until every tree is empty after `terminate`
    /// or stdin EOF. Returns the platform and the writer.
    pub fn run(mut self, pid: u32, inputs: &Receiver<Input>) -> (P, W) {
        self.record();
        self.emit(&Event::Leased { pid });
        while !(self.terminating && self.workers.is_empty()) {
            let input = match self.next_deadline() {
                Some(deadline) => {
                    match inputs.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                        Ok(input) => Some(input),
                        Err(RecvTimeoutError::Timeout) => None,
                        Err(RecvTimeoutError::Disconnected) => Some(Input::StdinClosed),
                    }
                }
                // `self.inputs` keeps the channel open, so this never fails.
                None => Some(inputs.recv().unwrap_or(Input::StdinClosed)),
            };
            if let Some(input) = input {
                self.handle(input);
            }
            self.force_due();
        }

        self.platform.sweep_orphans();
        let reports = std::mem::take(&mut self.reports);
        self.emit(&Event::Terminated { reports });
        (self.platform, self.out)
    }

    fn emit(&mut self, event: &Event) {
        // A host that stopped reading is gone; its stdin EOF ends the run.
        let _ = self
            .out
            .write_all(encode_event(event).as_bytes())
            .and_then(|()| self.out.flush());
    }

    fn record(&mut self) {
        let workers: Vec<RecordedWorker> = self
            .workers
            .iter()
            .map(|worker| RecordedWorker {
                id: worker.id.clone(),
                pid: worker.tree.pid(),
                start_time: worker.tree.start_time().to_string(),
                serial: worker.serial,
            })
            .collect();
        self.platform.record(&workers);
    }

    fn next_deadline(&self) -> Option<Instant> {
        self.workers
            .iter()
            .filter_map(|worker| worker.deadline)
            .min()
    }

    fn handle(&mut self, input: Input) {
        match input {
            Input::Line(line) => match parse_request(&line) {
                Ok(request) => self.request(request),
                Err(err) => eprintln!("forge-reaper: ignored line ({err}): {line}"),
            },
            Input::StdinClosed => {
                self.terminating = true;
                for index in 0..self.workers.len() {
                    self.stop(index, Duration::ZERO);
                }
            }
            Input::LeaderExited(serial) => self.finish(serial),
        }
    }

    fn request(&mut self, request: Request) {
        match request {
            Request::Go => self.admitted = true,
            Request::Spawn(spawn) => self.spawn(&spawn),
            Request::Stop { id, grace_ms } => {
                if let Some(index) = self.workers.iter().position(|worker| worker.id == id) {
                    self.stop(index, Duration::from_millis(grace_ms));
                }
            }
            Request::Terminate { grace_ms } => {
                self.terminating = true;
                for index in 0..self.workers.len() {
                    self.stop(index, Duration::from_millis(grace_ms));
                }
            }
        }
    }

    fn reject(&mut self, id: &str, reason: RejectReason, message: String) {
        self.emit(&Event::Rejected {
            id: id.to_owned(),
            reason,
            message,
        });
    }

    fn spawn(&mut self, request: &SpawnRequest) {
        let id = &request.id;
        if self.terminating {
            let message = "the reaper is terminating and spawns nothing more".to_owned();
            return self.reject(id, RejectReason::Terminating, message);
        }
        if !self.admitted {
            let message = "the host has not sent go".to_owned();
            return self.reject(id, RejectReason::NotAdmitted, message);
        }
        if self.workers.iter().any(|worker| &worker.id == id) {
            let message = format!("a live worker is named {id}");
            return self.reject(id, RejectReason::DuplicateId, message);
        }

        let serial = self.next_serial;
        self.next_serial += 1;
        let tree = match self.platform.spawn(serial, request) {
            Ok(tree) => Arc::new(tree),
            Err(err) => {
                let message = format!("{}: {err}", request.file);
                return self.reject(id, RejectReason::SpawnFailed, message);
            }
        };

        self.emit(&Event::Spawned {
            id: id.clone(),
            pid: tree.pid(),
            start_time: tree.start_time().to_string(),
        });
        tree.release();
        let waiter = Arc::clone(&tree);
        let inputs = self.inputs.clone();
        thread::spawn(move || {
            if let Err(err) = waiter.wait_leader() {
                eprintln!("forge-reaper: wait for worker {serial}: {err}");
            }
            let _ = inputs.send(Input::LeaderExited(serial));
        });
        self.workers.push(Worker {
            serial,
            id: id.clone(),
            tree,
            deadline: None,
            forced: false,
        });
        self.record();
    }

    /// Start the stop sequence, or move its forced kill earlier.
    fn stop(&mut self, index: usize, grace: Duration) {
        let worker = &mut self.workers[index];
        let due = Instant::now() + grace;
        if worker.deadline.is_some_and(|deadline| deadline <= due) {
            return;
        }

        let is_first = worker.deadline.is_none();
        worker.deadline = Some(due);
        if grace.is_zero() || (is_first && worker.tree.signal_graceful().is_err()) {
            Self::force(worker);
        }
    }

    fn force(worker: &mut Worker<P::Tree>) {
        worker.forced = true;
        // Keep a deadline so the worker stays "stopping", but far away: the
        // leader's exit now finishes it.
        worker.deadline = Some(Instant::now() + CONFIRM_BOUND * 1000);
        if let Err(err) = worker.tree.kill() {
            eprintln!("forge-reaper: kill worker {}: {err}", worker.id);
        }
    }

    fn force_due(&mut self) {
        let now = Instant::now();
        for worker in &mut self.workers {
            if !worker.forced && worker.deadline.is_some_and(|deadline| deadline <= now) {
                Self::force(worker);
            }
        }
    }

    fn finish(&mut self, serial: u64) {
        let Some(index) = self
            .workers
            .iter()
            .position(|worker| worker.serial == serial)
        else {
            return;
        };
        let worker = self.workers.remove(index);
        // The leader is gone but its tree may not be: a service that died
        // leaves no orphans.
        if let Err(err) = worker.tree.kill() {
            eprintln!("forge-reaper: kill the rest of worker {}: {err}", worker.id);
        }
        let finished = worker.tree.finish(CONFIRM_BOUND).unwrap_or_else(|err| {
            eprintln!("forge-reaper: finish worker {}: {err}", worker.id);
            Finished {
                status: ExitStatus::default(),
                empty: false,
                survivors: Vec::new(),
            }
        });
        // The tree is gone (or reported incomplete): the record drops it.
        self.record();
        let report = Report {
            exit_code: finished.status.code,
            signal: finished.status.signal,
            forced: worker.forced,
            incomplete: !finished.empty,
            survivors: finished.survivors,
        };
        self.emit(&Event::Exited {
            id: worker.id.clone(),
            report: report.clone(),
        });
        self.reports.push(FinalReport {
            id: worker.id,
            report,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::{ExitStatus, Finished, Input, Platform, Reaper, RecordedWorker, Tree};
    use crate::protocol::SpawnRequest;
    use std::io;
    use std::sync::mpsc::{self, Sender};
    use std::sync::{Arc, Condvar, Mutex};
    use std::thread;
    use std::time::Duration;

    /// What happened to fake trees, in order, shared with the test.
    type Log = Arc<Mutex<Vec<String>>>;

    /// A tree whose leader exits when the test (or a kill) says so.
    struct FakeTree {
        serial: u64,
        log: Log,
        exited: Arc<(Mutex<bool>, Condvar)>,
        /// The leader exits on its graceful signal.
        obeys: bool,
        /// What `finish` reports as still alive.
        survivors: Vec<u32>,
    }

    impl FakeTree {
        fn exit(&self) {
            let (lock, ready) = &*self.exited;
            *lock.lock().unwrap() = true;
            ready.notify_all();
        }

        fn note(&self, what: &str) {
            self.log
                .lock()
                .unwrap()
                .push(format!("{what} {}", self.serial));
        }
    }

    impl Tree for FakeTree {
        fn pid(&self) -> u32 {
            100 + u32::try_from(self.serial).unwrap()
        }
        fn start_time(&self) -> u64 {
            7
        }
        fn release(&self) {
            self.note("release");
        }
        fn signal_graceful(&self) -> io::Result<()> {
            self.note("graceful");
            if self.obeys {
                self.exit();
            }
            Ok(())
        }
        fn kill(&self) -> io::Result<()> {
            self.note("kill");
            self.exit();
            Ok(())
        }
        fn wait_leader(&self) -> io::Result<()> {
            let (lock, ready) = &*self.exited;
            let _exited = ready
                .wait_while(lock.lock().unwrap(), |exited| !*exited)
                .unwrap();
            Ok(())
        }
        fn finish(&self, _bound: Duration) -> io::Result<Finished> {
            self.note("finish");
            Ok(Finished {
                status: ExitStatus {
                    code: Some(0),
                    signal: None,
                },
                empty: self.survivors.is_empty(),
                survivors: self.survivors.clone(),
            })
        }
    }

    struct FakePlatform {
        log: Log,
        /// Leaders that exit on their graceful signal.
        obeys: bool,
        fails: bool,
        survivors: Vec<u32>,
    }

    impl Platform for FakePlatform {
        type Tree = FakeTree;
        fn spawn(&mut self, serial: u64, request: &SpawnRequest) -> io::Result<FakeTree> {
            if self.fails {
                return Err(io::Error::from(io::ErrorKind::NotFound));
            }
            self.log
                .lock()
                .unwrap()
                .push(format!("spawn {serial} {}", request.id));
            Ok(FakeTree {
                serial,
                log: Arc::clone(&self.log),
                exited: Arc::new((Mutex::new(false), Condvar::new())),
                obeys: self.obeys,
                survivors: self.survivors.clone(),
            })
        }

        fn record(&mut self, workers: &[RecordedWorker]) {
            let ids: Vec<&str> = workers.iter().map(|worker| worker.id.as_str()).collect();
            self.log
                .lock()
                .unwrap()
                .push(format!("record [{}]", ids.join(",")));
        }

        fn sweep_orphans(&mut self) {
            self.log.lock().unwrap().push("sweep".to_owned());
        }
    }

    fn spawn_line(id: &str) -> String {
        let request = serde_json::json!({
            "type": "spawn", "id": id, "file": "/bin/x", "args": [], "cwd": "/", "env": {},
        });
        request.to_string()
    }

    struct Run {
        events: Vec<serde_json::Value>,
        log: Vec<String>,
    }

    /// Run a reaper over `lines`, then EOF unless the lines end the run.
    fn run(platform: FakePlatform, lines: &[String], eof: bool) -> Run {
        let log = Arc::clone(&platform.log);
        let (sender, receiver) = mpsc::channel();
        feed(&sender, lines, eof);
        let reaper = Reaper::new(platform, Vec::new(), sender);
        let (_, out) = reaper.run(1, &receiver);
        let events = String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let log = log.lock().unwrap().clone();
        Run { events, log }
    }

    fn feed(sender: &Sender<Input>, lines: &[String], eof: bool) {
        let sender = sender.clone();
        let lines = lines.to_vec();
        thread::spawn(move || {
            for line in lines {
                sender.send(Input::Line(line)).unwrap();
            }
            if eof {
                sender.send(Input::StdinClosed).unwrap();
            }
        });
    }

    fn platform(obeys: bool) -> FakePlatform {
        FakePlatform {
            log: Arc::default(),
            obeys,
            fails: false,
            survivors: Vec::new(),
        }
    }

    fn types(run: &Run) -> Vec<String> {
        run.events
            .iter()
            .map(|event| event["type"].as_str().unwrap().to_owned())
            .collect()
    }

    fn go() -> String {
        r#"{"type":"go"}"#.to_owned()
    }

    fn terminate(grace_ms: u64) -> String {
        format!(r#"{{"type":"terminate","graceMs":{grace_ms}}}"#)
    }

    #[test]
    fn rejects_spawns_before_go() {
        let run = run(platform(true), &[spawn_line("a")], true);

        assert_eq!(types(&run), ["leased", "rejected", "terminated"]);
        assert_eq!(run.events[1]["reason"], "not_admitted");
        assert_eq!(run.log, ["record []", "sweep"]);
    }

    #[test]
    fn spawns_after_go_and_releases_the_leader_after_reporting_it() {
        let run = run(
            platform(true),
            &[go(), spawn_line("a"), terminate(1000)],
            false,
        );

        assert_eq!(types(&run), ["leased", "spawned", "exited", "terminated"]);
        assert_eq!(run.events[1]["pid"], 100);
        assert_eq!(run.events[1]["startTime"], "7");
        assert_eq!(
            run.log,
            [
                "record []",
                "spawn 0 a",
                "release 0",
                "record [a]",
                "graceful 0",
                "kill 0",
                "finish 0",
                "record []",
                "sweep"
            ]
        );
        assert_eq!(run.events[2]["report"]["forced"], false);
    }

    #[test]
    fn reports_the_survivors_of_a_tree_that_did_not_empty() {
        let run = run(
            FakePlatform {
                survivors: vec![41, 42],
                ..platform(true)
            },
            &[go(), spawn_line("a"), terminate(1000)],
            false,
        );

        assert_eq!(run.events[2]["report"]["incomplete"], true);
        assert_eq!(
            run.events[2]["report"]["survivors"],
            serde_json::json!([41, 42])
        );
    }

    #[test]
    fn terminate_rejects_every_later_spawn() {
        let run = run(
            platform(false),
            &[go(), spawn_line("a"), terminate(200), spawn_line("b")],
            false,
        );

        assert_eq!(
            types(&run),
            ["leased", "spawned", "rejected", "exited", "terminated"]
        );
        assert_eq!(run.events[2]["reason"], "terminating");
        assert_eq!(run.events[4]["reports"][0]["id"], "a");
    }

    #[test]
    fn forces_a_worker_that_ignores_the_graceful_signal() {
        let run = run(
            platform(false),
            &[go(), spawn_line("a"), terminate(50)],
            false,
        );

        assert_eq!(run.events[2]["report"]["forced"], true);
        assert_eq!(
            run.log,
            [
                "record []",
                "spawn 0 a",
                "release 0",
                "record [a]",
                "graceful 0",
                "kill 0",
                "kill 0",
                "finish 0",
                "record []",
                "sweep"
            ]
        );
    }

    #[test]
    fn stdin_eof_kills_every_tree_without_grace() {
        let run = run(
            platform(true),
            &[go(), spawn_line("a"), spawn_line("b")],
            true,
        );

        assert_eq!(
            types(&run),
            [
                "leased",
                "spawned",
                "spawned",
                "exited",
                "exited",
                "terminated"
            ]
        );
        assert!(!run.log.iter().any(|entry| entry.starts_with("graceful")));
        assert_eq!(run.events[3]["report"]["forced"], true);
    }

    #[test]
    fn rejects_a_duplicate_live_id_and_a_failed_spawn() {
        let duplicate = run(
            platform(true),
            &[go(), spawn_line("a"), spawn_line("a")],
            true,
        );
        let failing = run(
            FakePlatform {
                fails: true,
                ..platform(true)
            },
            &[go(), spawn_line("a")],
            true,
        );

        assert_eq!(duplicate.events[2]["reason"], "duplicate_id");
        assert_eq!(failing.events[1]["reason"], "spawn_failed");
    }

    #[test]
    fn stop_ends_one_worker_and_frees_its_id() {
        let stop = r#"{"type":"stop","id":"a","graceMs":1000}"#.to_owned();
        let run = run(
            platform(true),
            &[go(), spawn_line("a"), stop, spawn_line("a")],
            true,
        );

        // The second spawn of `a` may land before or after the first `a`
        // is finished: both orders are valid, but never a duplicate.
        let spawned = types(&run).iter().filter(|kind| *kind == "spawned").count();
        let rejected = types(&run)
            .iter()
            .filter(|kind| *kind == "rejected")
            .count();
        assert_eq!(spawned + rejected, 2);
        assert_eq!(types(&run).last().unwrap(), "terminated");
    }

    #[test]
    fn records_every_live_worker() {
        let run = run(
            platform(false),
            &[go(), spawn_line("a"), spawn_line("b")],
            true,
        );

        let records: Vec<&String> = run
            .log
            .iter()
            .filter(|entry| entry.starts_with("record"))
            .collect();
        assert_eq!(records[..3], ["record []", "record [a]", "record [a,b]"]);
        assert_eq!(records.last().unwrap().as_str(), "record []");
    }

    #[test]
    fn ignores_lines_that_are_not_requests() {
        let run = run(platform(true), &["nonsense".to_owned()], true);

        assert_eq!(types(&run), ["leased", "terminated"]);
    }

    #[test]
    fn go_after_terminate_admits_nothing() {
        let run = run(
            platform(true),
            &[terminate(0), go(), spawn_line("a")],
            false,
        );

        assert_eq!(types(&run), ["leased", "terminated"]);
    }
}
