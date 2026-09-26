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
        markers: Vec::new(),
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

/// Markers unique to one test.
#[cfg(unix)]
fn markers(name: &str) -> Vec<(String, String)> {
    let id = format!("{}-{name}", std::process::id());
    vec![
        ("FORGE_TEST_SESSION".into(), id.clone()),
        ("FORGE_TEST_WORKER".into(), id),
    ]
}

#[cfg(unix)]
fn pairs(markers: &[(String, String)]) -> Vec<(&str, &str)> {
    markers
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .collect()
}

/// A `sleep` with these variables, and its row in the process table.
#[cfg(unix)]
fn marked_sleeper(
    variables: &[(String, String)],
) -> (std::process::Child, crate::os::process::ProcessEntry) {
    let child = std::process::Command::new("sleep")
        .arg("60")
        .envs(variables.iter().cloned())
        .stdin(std::process::Stdio::null())
        .spawn()
        .unwrap();
    // `spawn` can return while `exec` still sets up the new image, whose
    // environment reads empty until then.
    let pinned = crate::os::process::PinnedProcess::open(child.id())
        .unwrap()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while pinned.has_environment(&pairs(variables)).unwrap() != Some(true)
        && std::time::Instant::now() < deadline
    {
        thread::sleep(Duration::from_millis(5));
    }
    let entry = crate::os::process::processes()
        .unwrap()
        .into_iter()
        .find(|entry| entry.pid == child.id())
        .unwrap();
    (child, entry)
}

#[cfg(unix)]
#[test]
fn kill_marked_kills_a_process_with_every_marker_through_its_pin() {
    let markers = markers("hit");
    let (mut child, entry) = marked_sleeper(&markers);

    let killed = super::sys::kill_marked(&entry, &pairs(&markers)).map(|pin| pin.pid());
    let status = child.wait().unwrap();

    assert_eq!(killed, Some(entry.pid));
    assert_eq!(
        std::os::unix::process::ExitStatusExt::signal(&status),
        Some(libc::SIGKILL)
    );
}

/// The listing saw another process under this PID (another start
/// time), so the process now under it is never killed.
#[cfg(unix)]
#[test]
fn kill_marked_never_kills_a_process_that_reused_the_pid() {
    let markers = markers("reuse");
    let (mut child, mut entry) = marked_sleeper(&markers);
    entry.start_time -= 1;

    let killed = super::sys::kill_marked(&entry, &pairs(&markers)).is_some();
    let alive = child.try_wait().unwrap().is_none();
    child.kill().unwrap();
    child.wait().unwrap();

    assert!(!killed);
    assert!(alive);
}

#[cfg(unix)]
#[test]
fn kill_marked_never_kills_a_process_without_every_marker() {
    let markers = markers("partial");
    let (mut child, entry) = marked_sleeper(&markers[..1]);

    let killed = super::sys::kill_marked(&entry, &pairs(&markers)).is_some();
    let alive = child.try_wait().unwrap().is_none();
    child.kill().unwrap();
    child.wait().unwrap();

    assert!(!killed);
    assert!(alive);
}

/// A descendant that left the group (and outlived its parent) dies in
/// the forced stop through its markers.
#[cfg(unix)]
#[test]
fn finish_kills_a_marked_descendant_that_left_the_group() {
    let markers = markers("escape");
    let pid_file = directory("escape").join("escaped.pid");
    let script = format!(
        "perl -e 'setpgrp(0, 0); open(F, \">{file}.tmp\"); print F $$; close F; \
         rename(\"{file}.tmp\", \"{file}\"); sleep 60' & \
         while [ ! -s {file} ]; do sleep 0.05; done; exit 0",
        file = pid_file.display()
    );
    let mut spec = shell("escape", &script, None);
    spec.env.extend(markers.iter().cloned());
    spec.markers = markers;
    let tree = WorkerTree::spawn(&spec, &Inherit::default()).unwrap();
    tree.release();
    tree.wait_leader().unwrap();
    let escaped: u32 = std::fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let pinned = crate::os::process::PinnedProcess::open(escaped)
        .unwrap()
        .unwrap();
    let group_before = crate::os::process::processes()
        .unwrap()
        .into_iter()
        .find(|entry| entry.pid == escaped)
        .map(|entry| entry.group);
    let finished = tree.finish(Duration::from_secs(5)).unwrap();

    assert_eq!(group_before, Some(escaped));
    assert_eq!(finished.survivors, Vec::<u32>::new());
    assert!(finished.empty);
    assert!(pinned.wait_for_exit(Duration::from_secs(5)).unwrap());
}
