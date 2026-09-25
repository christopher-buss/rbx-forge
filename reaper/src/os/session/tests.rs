//! Session scans and forced cleanup with real processes. Each test uses its
//! own session id, so tests running at once never see each other's
//! processes.

use super::{Target, force_cleanup, scan};
use crate::os::process::{PinnedProcess, start_time};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const BOUND: Duration = Duration::from_secs(10);

/// A test's session directory, lease, and record.
struct Session {
    id: String,
    lease: PathBuf,
    record: PathBuf,
}

impl Session {
    fn new(name: &str) -> Self {
        let id = format!("test-{}-{name}", std::process::id());
        let directory = std::env::temp_dir().join(format!("forge-session-{id}"));
        std::fs::create_dir_all(&directory).unwrap();
        let lease = directory.join("workers.lock");
        std::fs::write(&lease, "").unwrap();
        Self {
            id,
            lease,
            record: directory.join("reaper.json"),
        }
    }

    fn target(&self) -> Target<'_> {
        Target {
            session: &self.id,
            lease: &self.lease,
            record: &self.record,
        }
    }

    /// Write a reaper record naming `reaper` and workers `(pid, serial)`.
    fn write_record(&self, reaper: u32, workers: &[(u32, u64)]) {
        let workers: Vec<serde_json::Value> = workers
            .iter()
            .map(|(pid, serial)| {
                serde_json::json!({
                    "id": format!("worker-{serial}"),
                    "pid": pid,
                    "startTime": start_time(*pid).unwrap().unwrap().to_string(),
                    "serial": serial,
                })
            })
            .collect();
        let record = serde_json::json!({
            "pid": reaper,
            "startTime": start_time(reaper).unwrap().unwrap().to_string(),
            "sessionId": self.id,
            "workers": workers,
        });
        std::fs::write(&self.record, record.to_string()).unwrap();
    }

    /// Scan until `check` holds, for up to five seconds: `spawn` returns
    /// before `exec` has set up the new image.
    fn scan_until(&self, check: impl Fn(&[u32]) -> bool) -> Vec<u32> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let pids: Vec<u32> = scan(&self.target())
                .unwrap()
                .iter()
                .map(|member| member.pid)
                .collect();
            if check(&pids) || Instant::now() >= deadline {
                return pids;
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}

/// Kills and reaps a child when the test ends, however it ends.
struct Owned(Child);

impl Owned {
    fn pid(&self) -> u32 {
        self.0.id()
    }

    /// Whether it has exited (reaping it).
    fn has_exited_within(&mut self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if self.0.try_wait().unwrap().is_some() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn sleeper_command() -> Command {
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
        .stderr(Stdio::null());
    command
}

fn sleeper() -> Owned {
    Owned(sleeper_command().spawn().unwrap())
}

#[cfg(unix)]
fn marked(session: &Session) -> Owned {
    Owned(
        sleeper_command()
            .env(super::SESSION_MARKER, &session.id)
            .spawn()
            .unwrap(),
    )
}

/// A shell that opens the lease itself and keeps it open in `sleep`: no
/// marker, only the descriptor.
#[cfg(unix)]
fn lease_holder(session: &Session) -> Owned {
    Owned(
        Command::new("/bin/sh")
            .args(["-c", "exec 3<\"$LEASE\"; exec sleep 60"])
            .env("LEASE", &session.lease)
            .env_remove(super::SESSION_MARKER)
            .stdin(Stdio::null())
            .spawn()
            .unwrap(),
    )
}

#[test]
fn an_unknown_session_has_no_members() {
    let session = Session::new("unknown");
    let _bystander = sleeper();

    assert_eq!(scan(&session.target()).unwrap(), Vec::new());
    assert_eq!(
        force_cleanup(&session.target(), BOUND).unwrap(),
        super::Cleanup::default()
    );
}

#[cfg(unix)]
#[test]
fn scan_finds_marked_processes_and_lease_holders_only() {
    let session = Session::new("scan");
    let other = Session::new("scan-other");
    let marker = marked(&session);
    let holder = lease_holder(&session);
    let _stranger = marked(&other);
    let _bystander = sleeper();

    let mut pids = session.scan_until(|pids| pids.len() >= 2);
    pids.sort_unstable();
    let mut expected = vec![marker.pid(), holder.pid()];
    expected.sort_unstable();

    assert_eq!(pids, expected);
}

#[cfg(unix)]
#[test]
fn force_cleanup_kills_members_leaf_first_and_leaves_the_rest() {
    let session = Session::new("leaf");
    // A marked shell and its marked child `sleep`.
    let mut parent = Owned(
        Command::new("/bin/sh")
            .args(["-c", "sleep 60 & wait"])
            .env(super::SESSION_MARKER, &session.id)
            .stdin(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let mut bystander = sleeper();
    let found = session.scan_until(|pids| pids.len() >= 2);
    let child = *found.iter().find(|pid| **pid != parent.pid()).unwrap();

    let cleanup = force_cleanup(&session.target(), BOUND).unwrap();

    assert_eq!(cleanup.killed, vec![child, parent.pid()]);
    assert_eq!(cleanup.survivors, Vec::<u32>::new());
    assert!(parent.has_exited_within(Duration::from_secs(5)));
    assert!(!bystander.has_exited_within(Duration::ZERO));
}

#[cfg(unix)]
#[test]
fn force_cleanup_kills_the_recorded_reaper_last() {
    let session = Session::new("reaper");
    let mut reaper = sleeper();
    let mut worker = marked(&session);
    let mut holder = lease_holder(&session);
    session.write_record(reaper.pid(), &[(worker.pid(), 0)]);
    session.scan_until(|pids| pids.len() >= 3);

    let cleanup = force_cleanup(&session.target(), BOUND).unwrap();

    assert_eq!(cleanup.killed.last(), Some(&reaper.pid()));
    assert_eq!(cleanup.killed.len(), 3);
    assert!(worker.has_exited_within(Duration::from_secs(5)));
    assert!(holder.has_exited_within(Duration::from_secs(5)));
    assert!(reaper.has_exited_within(Duration::from_secs(5)));
}

#[test]
fn a_record_whose_start_time_does_not_match_names_no_one() {
    let session = Session::new("stale");
    let mut stranger = sleeper();
    let record = serde_json::json!({
        "pid": stranger.pid(),
        "startTime": "1",
        "sessionId": session.id,
        "workers": [],
    });
    std::fs::write(&session.record, record.to_string()).unwrap();

    assert_eq!(scan(&session.target()).unwrap(), Vec::new());
    assert_eq!(
        force_cleanup(&session.target(), BOUND).unwrap().killed,
        Vec::<u32>::new()
    );
    assert!(!stranger.has_exited_within(Duration::ZERO));
}

#[test]
fn the_recorded_reaper_is_a_member_while_it_lives() {
    let session = Session::new("member");
    let reaper = sleeper();
    session.write_record(reaper.pid(), &[]);
    let pinned = PinnedProcess::open(reaper.pid()).unwrap().unwrap();

    let members = scan(&session.target()).unwrap();

    assert_eq!(members.len(), 1);
    assert_eq!(members[0].pid, reaper.pid());
    assert_eq!(members[0].start_time, pinned.start_time());
    assert!(members[0].reaper);
}

#[cfg(windows)]
#[test]
fn force_cleanup_terminates_the_recorded_jobs_then_the_reaper() {
    use crate::os::worker::{Inherit, Spec, WorkerTree};

    let session = Session::new("jobs");
    let mut reaper = sleeper();
    let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
    let tree = WorkerTree::spawn(
        &Spec {
            file: PathBuf::from(comspec),
            args: vec!["/d".into(), "/c".into(), "ping -n 60 127.0.0.1 >NUL".into()],
            cwd: std::env::temp_dir(),
            env: std::env::vars().collect(),
            markers: Vec::new(),
            log: None,
            verbatim: true,
            job_name: super::job_name(&session.id, 3),
        },
        &Inherit::default(),
    )
    .unwrap();
    tree.release();
    session.write_record(reaper.pid(), &[(tree.pid(), 3)]);
    let found = session.scan_until(|pids| pids.len() >= 3);

    let cleanup = force_cleanup(&session.target(), BOUND).unwrap();
    tree.wait_leader().unwrap();

    assert!(found.contains(&tree.pid()) && found.contains(&reaper.pid()));
    assert_eq!(cleanup.killed.last(), Some(&reaper.pid()));
    assert!(cleanup.killed.contains(&tree.pid()));
    assert_eq!(cleanup.survivors, Vec::<u32>::new());
    assert!(reaper.has_exited_within(Duration::from_secs(5)));
}
