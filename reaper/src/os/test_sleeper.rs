//! A test process that sleeps until killed: the test binary itself, so its
//! environment stays readable. Platform binaries hide their environment from
//! `KERN_PROCARGS2` on macOS 27.

use std::process::{Command, Stdio};
use std::time::Duration;

const SLEEP: &str = "FORGE_TEST_SLEEPER";
/// The sleeper waits on one sleeper child instead.
const PARENT: &str = "FORGE_TEST_SLEEPER_PARENT";
/// The sleeper leaves its group, then writes its PID to this file.
const PID_FILE: &str = "FORGE_TEST_SLEEPER_PID_FILE";
const NAME: &str = "os::test_sleeper::sleeps_when_asked";

/// A sleeper with null standard streams.
pub fn command() -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([NAME, "--exact", "--test-threads=1", "--quiet"])
        .env(SLEEP, "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

#[cfg(unix)]
/// A sleeper that waits on a sleeper child.
pub fn parent_command() -> Command {
    let mut command = command();
    command.env(PARENT, "1");
    command
}

#[cfg(unix)]
/// A shell line that starts a sleeper in its own group, which writes its PID
/// to `pid_file` once it left.
pub fn escaping_shell_line(pid_file: &std::path::Path) -> String {
    format!(
        "{SLEEP}=1 {PID_FILE}='{}' '{}' {NAME} --exact --test-threads=1 --quiet",
        pid_file.display(),
        std::env::current_exe().unwrap().display()
    )
}

/// The sleeper's body; a plain test run finds no request and returns.
#[test]
fn sleeps_when_asked() {
    if std::env::var_os(SLEEP).is_none() {
        return;
    }
    if std::env::var_os(PARENT).is_some() {
        let mut child = command();
        child.env_remove(PARENT).spawn().unwrap().wait().unwrap();
        return;
    }
    #[cfg(unix)]
    if let Some(file) = std::env::var_os(PID_FILE) {
        // SAFETY: plain call on this process.
        assert_eq!(unsafe { libc::setpgid(0, 0) }, 0);
        let file = std::path::PathBuf::from(file);
        let temporary = file.with_extension("tmp");
        std::fs::write(&temporary, std::process::id().to_string()).unwrap();
        std::fs::rename(&temporary, &file).unwrap();
    }

    std::thread::sleep(Duration::from_secs(60));
}
