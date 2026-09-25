//! Spike programs for ticket #36 (throwaway).
//!
//! Windows: `probe`, `via-parent`, `synthetic`, `alive`, `sleep`, `pipe`.
//! Unix: `envscan`, `hold`.

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod win;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    #[cfg(windows)]
    win::run(&args);
    #[cfg(unix)]
    unix::run(&args);
}
