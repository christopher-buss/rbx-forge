//! Worker trees with real processes: `cmd.exe` on Windows, `/bin/sh`
//! elsewhere. Scenarios with grandchildren and signals run through the Node
//! API (`test/integration/reaper.spec.ts`).

use super::{Inherit, Spec, WorkerTree};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

fn directory(name: &str) -> PathBuf {
    let directory =
        std::env::temp_dir().join(format!("forge-worker-test-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    directory
}

/// A shell running `script` (`cmd.exe /d /c` or `/bin/sh -c`).
fn shell(name: &str, script: &str, log: Option<&Path>) -> Spec {
    let (file, args, verbatim) = if cfg!(windows) {
        let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
        let args = vec![
            "/d".into(),
            "/s".into(),
            "/c".into(),
            format!("\"{script}\""),
        ];
        (PathBuf::from(comspec), args, true)
    } else {
        let args = vec!["-c".into(), script.into()];
        (PathBuf::from("/bin/sh"), args, false)
    };
    Spec {
        file,
        args,
        cwd: directory(name),
        env: std::env::vars().collect(),
        log: log.map(Path::to_path_buf),
        verbatim,
        job_name: format!("Local\\rbx-forge-test-{}-{name}", std::process::id()),
    }
}

fn sleep_script() -> &'static str {
    if cfg!(windows) {
        "ping -n 60 127.0.0.1 >NUL"
    } else {
        "sleep 60"
    }
}

#[test]
fn a_worker_runs_nothing_until_release() {
    let marker = directory("gate").join("ran.txt");
    let script = format!("echo ran> {}", marker.display());
    let tree = WorkerTree::spawn(&shell("gate", &script, None), &Inherit::default()).unwrap();
    thread::sleep(Duration::from_millis(300));
    let before = marker.exists();
    tree.release();
    tree.wait_leader().unwrap();
    let finished = tree.finish(Duration::from_secs(5)).unwrap();

    assert!(!before);
    assert!(marker.exists());
    assert_eq!(finished.status.code, Some(0));
    assert!(finished.empty);
}

#[test]
fn reports_the_exit_code_and_writes_output_to_the_log() {
    let log = directory("log").join("worker.log");
    let tree = WorkerTree::spawn(
        &shell("log", "echo hello&& exit 3", Some(&log)),
        &Inherit::default(),
    )
    .unwrap();
    tree.release();
    tree.wait_leader().unwrap();
    let finished = tree.finish(Duration::from_secs(5)).unwrap();

    assert_eq!(finished.status.code, Some(3));
    assert!(std::fs::read_to_string(&log).unwrap().starts_with("hello"));
}

#[test]
fn kill_ends_a_running_tree() {
    let tree =
        WorkerTree::spawn(&shell("kill", sleep_script(), None), &Inherit::default()).unwrap();
    tree.release();
    thread::sleep(Duration::from_millis(200));
    tree.kill().unwrap();
    tree.wait_leader().unwrap();
    let finished = tree.finish(Duration::from_secs(5)).unwrap();

    assert!(finished.empty);
    assert_ne!(finished.status.code, Some(0));
}

#[test]
fn reports_the_leader_pid_and_start_time() {
    let tree = WorkerTree::spawn(&shell("pid", sleep_script(), None), &Inherit::default()).unwrap();
    let start = crate::os::process::start_time(tree.pid()).unwrap();
    tree.kill().unwrap();
    tree.wait_leader().unwrap();
    tree.finish(Duration::from_secs(5)).unwrap();

    assert_eq!(start, Some(tree.start_time()));
}

#[cfg(unix)]
#[test]
fn a_graceful_signal_reaches_the_leader() {
    let tree = WorkerTree::spawn(
        &shell("graceful", sleep_script(), None),
        &Inherit::default(),
    )
    .unwrap();
    tree.release();
    thread::sleep(Duration::from_millis(200));
    tree.signal_graceful().unwrap();
    tree.wait_leader().unwrap();
    let finished = tree.finish(Duration::from_secs(5)).unwrap();

    assert_eq!(finished.status.signal, Some(libc::SIGTERM));
}

#[test]
fn a_missing_program_fails_to_spawn() {
    let mut spec = shell("missing", "", None);
    spec.file = directory("missing").join("no-such-program");

    assert!(WorkerTree::spawn(&spec, &Inherit::default()).is_err());
}
