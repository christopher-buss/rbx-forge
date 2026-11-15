#[path = "../helper.rs"]
mod helper;
#[path = "../helper_probe.rs"]
mod helper_probe;
#[allow(
    dead_code,
    unfulfilled_lint_expectations,
    reason = "shared OS modules serve the addon and reaper too"
)]
#[path = "../os/mod.rs"]
mod os;
#[cfg(windows)]
#[allow(dead_code, reason = "the addon uses the PID-returning launcher")]
#[path = "../windows_studio.rs"]
mod windows_studio;

fn main() -> std::io::Result<()> {
    helper::serve(std::io::stdin().lock(), std::io::stdout().lock())
}
