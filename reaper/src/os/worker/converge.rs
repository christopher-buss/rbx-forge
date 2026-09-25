//! The bounded discover–kill loop of a POSIX forced stop (spec #28).
//!
//! Each pass kills every target it finds and returns the PIDs that were
//! still alive. New targets (a fork storm, a chain that forks as it dies)
//! show up in the next pass. The loop ends when two passes in a row find
//! nothing, or at the bound with the last pass's survivors: it never hangs.
//!
//! The second empty pass covers a process caught inside `exec`: until the
//! new image is set up, its environment reads empty, so its markers do not
//! show.

use std::io;
use std::thread;
use std::time::{Duration, Instant};

/// Empty passes in a row that end the loop.
const SETTLED: u32 = 2;

/// Run `pass` until it finds no live target twice in a row, or `bound`
/// runs out.
///
/// Returns the PIDs alive at the last pass: empty when the tree is gone.
///
/// # Errors
///
/// The first error of a pass.
pub fn converge(
    mut pass: impl FnMut() -> io::Result<Vec<u32>>,
    bound: Duration,
    interval: Duration,
) -> io::Result<Vec<u32>> {
    let deadline = Instant::now() + bound;
    let mut empty_passes = 0;
    loop {
        let alive = pass()?;
        empty_passes = if alive.is_empty() {
            empty_passes + 1
        } else {
            0
        };
        if empty_passes >= SETTLED || Instant::now() >= deadline {
            return Ok(alive);
        }

        thread::sleep(interval);
    }
}

#[cfg(test)]
mod tests {
    use super::converge;
    use std::io;
    use std::time::{Duration, Instant};

    const INTERVAL: Duration = Duration::from_millis(1);

    #[test]
    fn ends_once_two_passes_in_a_row_find_nothing() {
        let found = [vec![7], vec![], vec![8], vec![], vec![], vec![9]];
        let mut passes = 0;
        let survivors = converge(
            || {
                passes += 1;
                Ok(found[passes - 1].clone())
            },
            Duration::from_secs(10),
            INTERVAL,
        );

        assert_eq!(survivors.unwrap(), Vec::<u32>::new());
        assert_eq!(passes, 5);
    }

    #[test]
    fn reports_the_survivors_of_the_last_pass_at_the_bound() {
        let started = Instant::now();
        let mut passes = 0_u32;
        let survivors = converge(
            || {
                passes += 1;
                Ok(vec![7, 100 + passes])
            },
            Duration::from_millis(50),
            INTERVAL,
        );

        assert_eq!(survivors.unwrap(), vec![7, 100 + passes]);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn stops_at_a_failed_pass() {
        let result = converge(
            || Err(io::Error::other("no process table")),
            Duration::from_secs(10),
            INTERVAL,
        );

        assert!(result.is_err());
    }
}
