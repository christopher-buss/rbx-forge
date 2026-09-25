//! A whole session's processes: the evidence that ties a process to a
//! session, the barrier's scan, and forced cleanup (spec #28, "Sessions,
//! singleton, cleanup").
//!
//! A live process belongs to a session when:
//!
//! | OS      | Evidence                                                                 |
//! | ------- | ------------------------------------------------------------------------ |
//! | POSIX   | its environment holds the session marker (`RBX_FORGE_SESSION=<id>`); or it holds a descriptor on the session's lease file (every worker inherits it, so it outlives a scrubbed environment); or it is the reaper the reaper record names |
//! | Windows | it is in one of the session's named jobs (the reaper record names the live workers' serials); or it is the recorded reaper |
//!
//! The reaper is known by its PID and start time from the record, so a
//! reused PID never counts. The calling process and its ancestors never
//! count: a `forge start` run from a hook of the old session carries its
//! marker.
//!
//! [`scan`] lists the members; the barrier waits until there are none.
//! [`force_cleanup`] kills them: each target is pinned, its evidence is read
//! again through the pin, and only then is it killed, leaf first. The reaper
//! goes last, once nothing else of the session is left. A target whose
//! evidence cannot be read is reported as unverifiable and never killed. The
//! loop is bounded and reports its survivors.
//!
//! A POSIX descendant that both scrubs its environment and closes the lease
//! leaves no evidence at all: an accepted limit (spec #28, scenario C9).

use std::io;
use std::path::Path;
use std::time::Duration;

use serde::Deserialize;

use super::process::StartTime;

/// The marker every worker carries (spec #28).
pub const SESSION_MARKER: &str = "RBX_FORGE_SESSION";
/// Pause between two passes of the cleanup loop.
const POLL_INTERVAL: Duration = Duration::from_millis(10);

/// One session's files, as the barrier and cleanup read them.
#[derive(Clone, Copy, Debug)]
pub struct Target<'a> {
    pub session: &'a str,
    /// The lease file (`workers.lock`).
    pub lease: &'a Path,
    /// The reaper record (`reaper.json`).
    pub record: &'a Path,
}

/// A live process of the session.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Member {
    pub pid: u32,
    /// POSIX: its parent's PID. Windows: 0 (jobs need no tree order).
    pub parent: u32,
    pub start_time: StartTime,
    /// The session's reaper, as its record names it.
    pub reaper: bool,
}

/// What a forced cleanup did.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Cleanup {
    /// The PIDs it killed, in kill order.
    pub killed: Vec<u32>,
    /// Members still alive at the bound.
    pub survivors: Vec<u32>,
    /// Members whose evidence could not be read again: not killed.
    pub unverifiable: Vec<u32>,
}

/// The reaper record, as far as cleanup reads it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    pid: u32,
    start_time: String,
    #[serde(default)]
    workers: Vec<RecordedWorker>,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(not(windows), expect(dead_code, reason = "only Windows jobs use them"))]
struct RecordedWorker {
    pid: u32,
    #[serde(default)]
    serial: Option<u64>,
}

impl Record {
    /// The record, or `None` when there is none. The reaper replaces it
    /// whole (temporary file, then rename), so it is never torn; a record
    /// that does not parse is treated as missing.
    fn read(path: &Path) -> io::Result<Option<Self>> {
        match std::fs::read_to_string(path) {
            Ok(text) => Ok(serde_json::from_str(&text).ok()),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err),
        }
    }

    fn reaper(&self) -> Option<(u32, StartTime)> {
        self.start_time.parse().ok().map(|start| (self.pid, start))
    }
}

/// The name of a worker's job: `Local\rbx-forge-<session>-<serial>`.
#[must_use]
pub fn job_name(session: &str, serial: u64) -> String {
    format!("Local\\rbx-forge-{session}-{serial}")
}

/// Every live member of the session: the barrier is clear when there is
/// none.
///
/// # Errors
///
/// When the OS refuses the process listing or the record cannot be read.
pub fn scan(target: &Target<'_>) -> io::Result<Vec<Member>> {
    sys::scan(target)
}

/// Kill every member of the session within `bound`: leaf first, the reaper
/// last. See the module docs.
///
/// # Errors
///
/// When the OS refuses the process listing or the record cannot be read.
pub fn force_cleanup(target: &Target<'_>, bound: Duration) -> io::Result<Cleanup> {
    sys::force_cleanup(target, bound)
}

#[cfg(unix)]
mod sys {
    use std::collections::{HashMap, HashSet};
    use std::io;
    use std::time::Duration;

    use super::{Cleanup, Member, POLL_INTERVAL, Record, SESSION_MARKER, Target};
    use crate::os::process::{self, FileId, PinnedProcess, ProcessEntry, StartTime};
    use crate::os::worker::converge::converge;

    /// What ties a process to the session.
    struct Evidence<'a> {
        session: &'a str,
        lease: Option<FileId>,
        reaper: Option<(u32, StartTime)>,
    }

    impl<'a> Evidence<'a> {
        fn load(target: &Target<'a>) -> io::Result<Self> {
            Ok(Self {
                session: target.session,
                lease: FileId::of(target.lease)?,
                reaper: Record::read(target.record)?.and_then(|record| record.reaper()),
            })
        }

        fn is_reaper(&self, pin: &PinnedProcess) -> bool {
            self.reaper == Some((pin.pid(), pin.start_time()))
        }

        /// Whether the pinned process belongs to the session, read through
        /// the pin. `Ok(None)` once it has exited.
        fn owns(&self, pin: &PinnedProcess) -> io::Result<Option<bool>> {
            if self.is_reaper(pin) {
                return Ok(Some(pin.is_alive()?));
            }

            match pin.has_environment(&[(SESSION_MARKER, self.session)])? {
                Some(false) => {}
                other => return Ok(other),
            }
            match self.lease {
                Some(lease) => pin.holds_file(lease),
                None => Ok(Some(false)),
            }
        }
    }

    /// This process and its ancestors: never members.
    fn own_line(entries: &[ProcessEntry]) -> HashSet<u32> {
        let parents: HashMap<u32, u32> = entries
            .iter()
            .map(|entry| (entry.pid, entry.ppid))
            .collect();
        let mut line = HashSet::new();
        let mut pid = std::process::id();
        while pid != 0 && line.insert(pid) {
            pid = parents.get(&pid).copied().unwrap_or(0);
        }
        line
    }

    /// The members, each pinned. A process whose evidence cannot be read
    /// (another user's) is not one.
    fn members(evidence: &Evidence<'_>) -> io::Result<Vec<(PinnedProcess, Member)>> {
        let entries = process::processes()?;
        let own = own_line(&entries);
        let mut found = Vec::new();
        for entry in entries {
            if entry.exited || own.contains(&entry.pid) {
                continue;
            }
            let Ok(Some(pin)) = PinnedProcess::open(entry.pid) else {
                continue;
            };
            // Another process took the PID since the listing.
            if pin.start_time() != entry.start_time {
                continue;
            }
            if matches!(evidence.owns(&pin), Ok(Some(true))) {
                let member = Member {
                    pid: entry.pid,
                    parent: entry.ppid,
                    start_time: entry.start_time,
                    reaper: evidence.is_reaper(&pin),
                };
                found.push((pin, member));
            }
        }
        Ok(found)
    }

    pub fn scan(target: &Target<'_>) -> io::Result<Vec<Member>> {
        let evidence = Evidence::load(target)?;
        Ok(members(&evidence)?
            .into_iter()
            .map(|(_, member)| member)
            .collect())
    }

    /// How many members are its ancestors: leaves have the most.
    fn depth(member: &Member, parents: &HashMap<u32, u32>) -> usize {
        let mut depth = 0;
        let mut pid = member.parent;
        while let Some(parent) = parents.get(&pid) {
            depth += 1;
            pid = *parent;
            // A parent loop cannot happen in a process table, but a listing
            // taken while PIDs are reused could show one.
            if depth > parents.len() {
                break;
            }
        }
        depth
    }

    /// Kill a member once its evidence, read again through its pin, still
    /// holds. `Ok(false)` when it is gone or no longer a member.
    fn verified_kill(evidence: &Evidence<'_>, pin: &PinnedProcess) -> io::Result<bool> {
        if evidence.owns(pin)? != Some(true) {
            return Ok(false);
        }
        pin.kill()
    }

    /// Everything one cleanup run keeps across passes.
    #[derive(Default)]
    struct Run {
        /// Pins of processes it killed: alive until each pin sees the exit.
        killed: Vec<PinnedProcess>,
        order: Vec<u32>,
        unverifiable: Vec<u32>,
    }

    impl Run {
        fn has_killed(&self, pin: &PinnedProcess) -> bool {
            self.killed
                .iter()
                .any(|killed| killed.pid() == pin.pid() && killed.start_time() == pin.start_time())
        }

        fn kill(&mut self, evidence: &Evidence<'_>, pin: PinnedProcess) {
            if self.has_killed(&pin) {
                return;
            }
            match verified_kill(evidence, &pin) {
                Ok(true) => {
                    self.order.push(pin.pid());
                    self.killed.push(pin);
                }
                Ok(false) => {}
                Err(_) => self.unverifiable.push(pin.pid()),
            }
        }

        /// One pass: kill every member but the reaper, leaf first; the
        /// reaper only once nothing else is alive or unverifiable. Returns
        /// the members still alive.
        fn pass(&mut self, evidence: &Evidence<'_>) -> io::Result<Vec<u32>> {
            self.unverifiable.clear();
            let (reapers, mut rest): (Vec<_>, Vec<_>) = members(evidence)?
                .into_iter()
                .partition(|(_, member)| member.reaper);
            let parents: HashMap<u32, u32> = rest
                .iter()
                .map(|(_, member)| (member.pid, member.parent))
                .collect();
            rest.sort_by_key(|(_, member)| std::cmp::Reverse(depth(member, &parents)));
            for (pin, _) in rest {
                self.kill(evidence, pin);
            }
            self.killed.retain(|pin| pin.is_alive().unwrap_or(false));
            if self.killed.is_empty() && self.unverifiable.is_empty() {
                for (pin, _) in reapers {
                    self.kill(evidence, pin);
                }
            }

            Ok(self.killed.iter().map(PinnedProcess::pid).collect())
        }
    }

    pub fn force_cleanup(target: &Target<'_>, bound: Duration) -> io::Result<Cleanup> {
        let evidence = Evidence::load(target)?;
        let mut run = Run::default();
        let survivors = converge(|| run.pass(&evidence), bound, POLL_INTERVAL)?;
        Ok(Cleanup {
            killed: run.order,
            survivors,
            unverifiable: run.unverifiable,
        })
    }
}

#[cfg(windows)]
mod sys {
    use std::ffi::OsStr;
    use std::io;
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::ptr::null_mut;
    use std::thread;
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        JOBOBJECT_BASIC_PROCESS_ID_LIST, JobObjectBasicProcessIdList, OpenJobObjectW,
        QueryInformationJobObject, TerminateJobObject,
    };

    use super::{Cleanup, Member, POLL_INTERVAL, Record, Target, job_name};
    use crate::os::process::{self, PinnedProcess};

    /// `JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE`.
    const JOB_ACCESS: u32 = 0x4 | 0x8;
    /// Exit code of a process ended by forced cleanup.
    const KILLED_EXIT_CODE: u32 = 1;
    /// Room for this many PIDs in one job listing.
    const MAX_LISTED: usize = 1024;

    struct Job(OwnedHandle);

    impl Job {
        /// Open the job with this name. `Ok(None)` when there is none: every
        /// handle to it is closed, so its processes were killed.
        fn open(name: &str) -> io::Result<Option<Self>> {
            let wide: Vec<u16> = OsStr::new(name).encode_wide().chain(Some(0)).collect();
            // SAFETY: a valid, NUL-terminated name; the result is checked.
            let handle = unsafe { OpenJobObjectW(JOB_ACCESS, 0, wide.as_ptr()) };
            if handle.is_null() {
                let err = io::Error::last_os_error();
                return if err.raw_os_error() == Some(ERROR_FILE_NOT_FOUND.cast_signed()) {
                    Ok(None)
                } else {
                    Err(err)
                };
            }
            // SAFETY: `OpenJobObjectW` returned a new handle nothing else owns.
            Ok(Some(Self(unsafe {
                OwnedHandle::from_raw_handle(handle.cast())
            })))
        }

        fn raw(&self) -> HANDLE {
            self.0.as_raw_handle().cast()
        }

        /// The PIDs in the job now.
        fn pids(&self) -> io::Result<Vec<u32>> {
            // The list is a header of two counts, then the PIDs.
            let mut buffer = vec![0_usize; 1 + MAX_LISTED];
            let bytes =
                u32::try_from(buffer.len() * size_of::<usize>()).map_err(io::Error::other)?;
            // SAFETY: the buffer holds `bytes` bytes and is aligned for the
            // struct.
            let ok = unsafe {
                QueryInformationJobObject(
                    self.raw(),
                    JobObjectBasicProcessIdList,
                    buffer.as_mut_ptr().cast(),
                    bytes,
                    null_mut(),
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: the buffer starts with the struct the call filled.
            let list = unsafe { &*buffer.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>() };
            let listed = (list.NumberOfProcessIdsInList as usize).min(MAX_LISTED);
            Ok(buffer[1..=listed]
                .iter()
                .filter_map(|pid| u32::try_from(*pid).ok())
                .collect())
        }

        fn terminate(&self) -> io::Result<()> {
            // SAFETY: the handle is open with terminate access.
            if unsafe { TerminateJobObject(self.raw(), KILLED_EXIT_CODE) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
    }

    /// The live jobs the record names.
    fn jobs(target: &Target<'_>, record: &Record) -> Vec<(u32, io::Result<Job>)> {
        record
            .workers
            .iter()
            .filter_map(|worker| {
                let serial = worker.serial?;
                match Job::open(&job_name(target.session, serial)) {
                    Ok(Some(job)) => Some((worker.pid, Ok(job))),
                    Ok(None) => None,
                    Err(err) => Some((worker.pid, Err(err))),
                }
            })
            .collect()
    }

    /// The recorded reaper, pinned, while it is alive with its start time.
    fn reaper(record: &Record) -> io::Result<Option<PinnedProcess>> {
        let Some((pid, start)) = record.reaper() else {
            return Ok(None);
        };
        Ok(PinnedProcess::open(pid)?.filter(|pin| pin.start_time() == start))
    }

    fn member(pid: u32, reaper: bool) -> Member {
        Member {
            pid,
            parent: 0,
            start_time: process::start_time(pid).ok().flatten().unwrap_or(0),
            reaper,
        }
    }

    pub fn scan(target: &Target<'_>) -> io::Result<Vec<Member>> {
        let Some(record) = Record::read(target.record)? else {
            return Ok(Vec::new());
        };
        let mut members = Vec::new();
        for (_, job) in jobs(target, &record) {
            members.extend(job?.pids()?.into_iter().map(|pid| member(pid, false)));
        }
        if let Some(pin) = reaper(&record)? {
            members.push(member(pin.pid(), true));
        }
        Ok(members)
    }

    /// Wait until the job is empty. `false` at the deadline.
    fn wait_empty(job: &Job, deadline: Instant) -> io::Result<bool> {
        loop {
            if job.pids()?.is_empty() {
                return Ok(true);
            }
            if Instant::now() >= deadline {
                return Ok(false);
            }
            thread::sleep(POLL_INTERVAL);
        }
    }

    pub fn force_cleanup(target: &Target<'_>, bound: Duration) -> io::Result<Cleanup> {
        let deadline = Instant::now() + bound;
        let Some(record) = Record::read(target.record)? else {
            return Ok(Cleanup::default());
        };
        let mut cleanup = Cleanup::default();
        for (pid, job) in jobs(target, &record) {
            let Ok(job) = job else {
                cleanup.unverifiable.push(pid);
                continue;
            };
            let pids = job.pids()?;
            job.terminate()?;
            cleanup.killed.extend(pids);
            if !wait_empty(&job, deadline)? {
                cleanup.survivors.extend(job.pids()?);
            }
        }
        if !cleanup.survivors.is_empty() || !cleanup.unverifiable.is_empty() {
            return Ok(cleanup);
        }

        match reaper(&record) {
            Ok(Some(pin)) => {
                if pin.kill()? {
                    cleanup.killed.push(pin.pid());
                }
                let left = deadline.saturating_duration_since(Instant::now());
                if !pin.wait_for_exit(left)? {
                    cleanup.survivors.push(pin.pid());
                }
            }
            Ok(None) => {}
            Err(_) => cleanup.unverifiable.push(record.pid),
        }
        Ok(cleanup)
    }
}

#[cfg(test)]
mod tests;
