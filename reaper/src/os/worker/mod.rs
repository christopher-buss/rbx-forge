//! Worker trees: one job (Windows) or one process group (POSIX) per worker.
//!
//! | OS      | Tree                                   | Graceful                     | Forced                         |
//! | ------- | -------------------------------------- | ---------------------------- | ------------------------------ |
//! | Windows | named job, `KILL_ON_JOB_CLOSE`, attached at creation (`PROC_THREAD_ATTRIBUTE_JOB_LIST`) | `CTRL_BREAK` to the group | `TerminateJobObject` |
//! | POSIX   | process group led by the worker        | `SIGTERM` to the group       | `SIGKILL` to the group         |
//!
//! A worker runs no code before the reaper has reported it: POSIX workers
//! wait on a gate pipe between `fork` and `exec`; Windows workers start
//! suspended. If the reaper dies before it opens the gate, the worker never
//! runs (POSIX: the gate reads EOF and the child exits; Windows: the job
//! closes and kills it).
//!
//! On POSIX the leader is never reaped before [`WorkerTree::finish`], so its
//! PID pins the group id for every group signal.

use std::io;
use std::path::PathBuf;
use std::time::Duration;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as sys;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as sys;

/// How a worker's leader ended.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ExitStatus {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

/// The end of a tree: its leader's status and whether it emptied in time.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Finished {
    pub status: ExitStatus,
    pub empty: bool,
}

/// Everything needed to create one worker.
#[derive(Debug)]
pub struct Spec {
    pub file: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// The complete environment, markers included.
    pub env: Vec<(String, String)>,
    /// stdout and stderr go here (appended); `None` discards them.
    pub log: Option<PathBuf>,
    /// Windows only: pass `args` joined with spaces, unquoted.
    pub verbatim: bool,
    /// Windows only: the job's name (`Local\...`).
    pub job_name: String,
}

/// One worker's tree. See the module docs.
#[derive(Debug)]
pub struct WorkerTree(sys::Tree);

impl WorkerTree {
    /// Create the worker, held until [`WorkerTree::release`].
    ///
    /// # Errors
    ///
    /// When the OS cannot create the job, the process, or its output file.
    pub fn spawn(spec: &Spec, inherit: &Inherit) -> io::Result<Self> {
        sys::Tree::spawn(spec, inherit).map(Self)
    }

    #[must_use]
    pub fn pid(&self) -> u32 {
        self.0.pid()
    }

    #[must_use]
    pub fn start_time(&self) -> u64 {
        self.0.start_time()
    }

    /// Let the leader run.
    pub fn release(&self) {
        self.0.release();
    }

    /// Ask every process of the tree to stop.
    ///
    /// # Errors
    ///
    /// When the OS refuses the signal.
    pub fn signal_graceful(&self) -> io::Result<()> {
        self.0.signal_graceful()
    }

    /// Kill every process of the tree.
    ///
    /// # Errors
    ///
    /// When the OS refuses the kill.
    pub fn kill(&self) -> io::Result<()> {
        self.0.kill()
    }

    /// Block until the leader exits, without reaping it.
    ///
    /// # Errors
    ///
    /// When the OS wait fails.
    pub fn wait_leader(&self) -> io::Result<()> {
        self.0.wait_leader()
    }

    /// After the leader exited: reap it, then wait up to `bound` for the
    /// tree to be empty.
    ///
    /// # Errors
    ///
    /// When the OS refuses a query.
    pub fn finish(&self, bound: Duration) -> io::Result<Finished> {
        self.0.finish(bound)
    }
}

/// Descriptors every worker inherits besides its standard streams.
#[derive(Debug, Default)]
pub struct Inherit {
    /// POSIX: the lease descriptor, so the lease lives as long as any
    /// process that holds it.
    #[cfg(unix)]
    pub lease: Option<std::os::fd::RawFd>,
}

#[cfg(test)]
mod tests;
