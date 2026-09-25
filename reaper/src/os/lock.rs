//! Advisory file locks: `LockFileEx` on Windows, `flock` on POSIX (through
//! `std::fs::File::try_lock`).
//!
//! A lock belongs to one open file, not to the process: two opens of the same
//! path in one process conflict like two processes do. The OS releases the lock
//! when the file closes, including when the holder dies.
//!
//! On Windows the lock is mandatory for the locked bytes, so other processes
//! cannot read a locked file. Lock files hold no data.

use std::fs::{File, OpenOptions, TryLockError};
use std::io;
use std::path::Path;

/// How a lock shares the file with other holders.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LockMode {
    /// One holder; conflicts with every other lock.
    Exclusive,
    /// Any number of shared holders; conflicts with an exclusive lock.
    Shared,
}

/// A held lock. Dropping it releases the lock.
#[derive(Debug)]
pub struct FileLock {
    // Held to keep the lock; closing the file releases it.
    #[cfg_attr(windows, expect(dead_code, reason = "only POSIX reads the descriptor"))]
    file: File,
}

impl FileLock {
    /// Take a lock on `path` without waiting. Creates the file when it is
    /// missing and never truncates it.
    ///
    /// Returns `Ok(None)` when another holder's lock conflicts.
    ///
    /// # Errors
    ///
    /// When the file cannot be opened or the OS cannot lock it (for example
    /// on some network drives).
    pub fn try_acquire(path: &Path, mode: LockMode) -> io::Result<Option<Self>> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)?;
        let result = match mode {
            LockMode::Exclusive => file.try_lock(),
            LockMode::Shared => file.try_lock_shared(),
        };

        match result {
            Ok(()) => Ok(Some(Self { file })),
            Err(TryLockError::WouldBlock) => Ok(None),
            Err(TryLockError::Error(err)) => Err(err),
        }
    }

    /// The locked file's descriptor. A process that inherits it shares the
    /// lock (`flock` belongs to the open file), so the lock lives until every
    /// holder has closed it.
    #[cfg(unix)]
    #[must_use]
    pub fn raw_fd(&self) -> std::os::fd::RawFd {
        std::os::fd::AsRawFd::as_raw_fd(&self.file)
    }
}

#[cfg(test)]
mod tests {
    use super::{FileLock, LockMode};
    use std::path::{Path, PathBuf};

    fn lock_path(name: &str) -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("forge-lock-test-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        directory.join("test.lock")
    }

    fn acquire(path: &Path, mode: LockMode) -> Option<FileLock> {
        FileLock::try_acquire(path, mode).unwrap()
    }

    #[test]
    fn exclusive_lock_excludes_every_other_lock() {
        let path = lock_path("exclusive");
        let held = acquire(&path, LockMode::Exclusive);

        assert!(held.is_some());
        assert!(acquire(&path, LockMode::Exclusive).is_none());
        assert!(acquire(&path, LockMode::Shared).is_none());
    }

    #[test]
    fn shared_locks_coexist_and_exclude_an_exclusive_lock() {
        let path = lock_path("shared");
        let first = acquire(&path, LockMode::Shared);
        let second = acquire(&path, LockMode::Shared);

        assert!(first.is_some() && second.is_some());
        assert!(acquire(&path, LockMode::Exclusive).is_none());
    }

    #[test]
    fn dropping_a_lock_releases_it() {
        let path = lock_path("drop");
        drop(acquire(&path, LockMode::Exclusive));

        assert!(acquire(&path, LockMode::Exclusive).is_some());
    }

    #[test]
    fn locking_keeps_the_file_content() {
        let path = lock_path("content");
        std::fs::write(&path, "kept").unwrap();
        drop(acquire(&path, LockMode::Exclusive));

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "kept");
    }
}
