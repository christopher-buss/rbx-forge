//! macOS: no pidfd, so the pin is the PID plus its start time, and every call
//! first checks that the PID still has that start time. A PID reused between
//! the check and the call (microseconds) is an accepted limit (spec #28).

use super::{ProcessEntry, StartTime};
use std::ffi::OsStr;
use std::io;
use std::mem::{size_of, zeroed};
use std::os::unix::ffi::OsStrExt;
use std::path::PathBuf;
use std::ptr;
use std::thread;
use std::time::{Duration, Instant};

/// How often [`Pin::wait_for_exit`] checks the process.
const POLL_INTERVAL: Duration = Duration::from_millis(10);
/// Room for processes that start between counting and listing.
const LIST_SLACK: usize = 64;

/// Start time of a live process. `Ok(None)` when no process has this PID or
/// it is a zombie.
pub fn start_time(pid: u32) -> io::Result<Option<StartTime>> {
    Ok(bsd_info(pid)?
        .filter(|info| info.pbi_status != libc::SZOMB)
        .map(|info| start_of(&info)))
}

fn start_of(info: &libc::proc_bsdinfo) -> StartTime {
    info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec
}

pub fn processes() -> io::Result<Vec<ProcessEntry>> {
    // SAFETY: a null buffer asks for the count only.
    let count = unsafe { libc::proc_listallpids(ptr::null_mut(), 0) };
    let count = usize::try_from(count).map_err(|_| io::Error::last_os_error())?;
    let mut pids: Vec<libc::c_int> = vec![0; count + LIST_SLACK];
    let bytes =
        libc::c_int::try_from(pids.len() * size_of::<libc::c_int>()).map_err(io::Error::other)?;
    // SAFETY: the buffer holds `bytes` bytes.
    let listed = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
    let listed = usize::try_from(listed).map_err(|_| io::Error::last_os_error())?;
    pids.truncate(listed.min(pids.len()));

    let mut entries = Vec::new();
    for pid in pids {
        let Ok(pid) = u32::try_from(pid) else {
            continue;
        };
        // A process that ended since the listing has no info left.
        if let Ok(Some(info)) = bsd_info(pid) {
            entries.push(ProcessEntry {
                pid,
                ppid: info.pbi_ppid,
                group: info.pbi_pgid,
                start_time: start_of(&info),
                exited: info.pbi_status == libc::SZOMB,
            });
        }
    }

    Ok(entries)
}

/// The environment strings in a `KERN_PROCARGS2` buffer: `argc`, the
/// executable path, NUL padding, `argc` arguments, then the environment,
/// each string ended by NUL.
fn environment_of(procargs: &[u8]) -> Option<&[u8]> {
    let argc = usize::try_from(i32::from_ne_bytes(procargs.get(..4)?.try_into().ok()?)).ok()?;
    let mut rest = &procargs[4..];
    // The executable path, then its padding.
    rest = &rest[rest.iter().position(|byte| *byte == 0)?..];
    rest = &rest[rest.iter().position(|byte| *byte != 0)?..];
    for _ in 0..argc {
        rest = &rest[rest.iter().position(|byte| *byte == 0)? + 1..];
    }

    Some(rest)
}

fn procargs(pid: u32) -> io::Result<Option<Vec<u8>>> {
    let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
    let mut argmax: libc::c_int = 0;
    let mut size = size_of::<libc::c_int>();
    // SAFETY: `argmax` holds `size` bytes.
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            2,
            (&raw mut argmax).cast(),
            &mut size,
            ptr::null_mut(),
            0,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }

    let raw_pid = libc::c_int::try_from(pid).map_err(io::Error::other)?;
    let mut buffer = vec![0_u8; usize::try_from(argmax).map_err(io::Error::other)?];
    let mut size = buffer.len();
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, raw_pid];
    // SAFETY: the buffer holds `size` bytes.
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            buffer.as_mut_ptr().cast(),
            &mut size,
            ptr::null_mut(),
            0,
        )
    } != 0
    {
        let err = io::Error::last_os_error();
        // A process that is gone, or a zombie, has no arguments to read.
        return if matches!(err.raw_os_error(), Some(libc::ESRCH | libc::EINVAL)) {
            Ok(None)
        } else {
            Err(err)
        };
    }

    buffer.truncate(size);
    Ok(Some(buffer))
}

/// The BSD info of a process, zombies included. `Ok(None)` when no process
/// has this PID.
fn bsd_info(pid: u32) -> io::Result<Option<libc::proc_bsdinfo>> {
    let raw_pid = libc::c_int::try_from(pid).map_err(io::Error::other)?;
    // SAFETY: `proc_bsdinfo` is plain data; all-zero is a valid value.
    let mut info: libc::proc_bsdinfo = unsafe { zeroed() };
    let size = libc::c_int::try_from(size_of::<libc::proc_bsdinfo>()).map_err(io::Error::other)?;
    // SAFETY: the buffer is a valid `proc_bsdinfo` of `size` bytes.
    let written = unsafe {
        libc::proc_pidinfo(
            raw_pid,
            libc::PROC_PIDTBSDINFO,
            0,
            (&raw mut info).cast(),
            size,
        )
    };
    if written <= 0 {
        let err = io::Error::last_os_error();
        return if err.raw_os_error() == Some(libc::ESRCH) {
            Ok(None)
        } else {
            Err(err)
        };
    }
    if written != size {
        return Err(io::Error::other("short proc_pidinfo result"));
    }

    Ok(Some(info))
}

/// A PID and the start time that proves it still names the pinned process.
#[derive(Debug)]
pub struct Pin {
    pid: u32,
    start: StartTime,
}

impl Pin {
    pub fn open(pid: u32) -> io::Result<Option<(Self, StartTime)>> {
        Ok(start_time(pid)?.map(|start| (Self { pid, start }, start)))
    }

    pub fn is_alive(&self) -> io::Result<bool> {
        Ok(start_time(self.pid)? == Some(self.start))
    }

    /// The initial environment block, read between two start-time checks.
    pub fn environment(&self) -> io::Result<Option<Vec<u8>>> {
        if !self.is_alive()? {
            return Ok(None);
        }

        let Some(procargs) = procargs(self.pid)? else {
            return Ok(None);
        };
        // Checked again: the PID may have been reused during the read.
        if !self.is_alive()? {
            return Ok(None);
        }

        Ok(Some(
            environment_of(&procargs)
                .ok_or_else(|| io::Error::other("unreadable KERN_PROCARGS2"))?
                .to_vec(),
        ))
    }

    pub fn executable_path(&self) -> io::Result<Option<PathBuf>> {
        if !self.is_alive()? {
            return Ok(None);
        }

        let raw_pid = libc::c_int::try_from(self.pid).map_err(io::Error::other)?;
        let mut buffer = vec![0_u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        let capacity = u32::try_from(buffer.len()).map_err(io::Error::other)?;
        // SAFETY: the buffer holds `capacity` bytes.
        let length = unsafe { libc::proc_pidpath(raw_pid, buffer.as_mut_ptr().cast(), capacity) };
        if length <= 0 {
            return Err(io::Error::last_os_error());
        }

        buffer.truncate(usize::try_from(length).map_err(io::Error::other)?);
        // Checked again: the PID may have been reused during the read.
        if !self.is_alive()? {
            return Ok(None);
        }

        Ok(Some(PathBuf::from(OsStr::from_bytes(&buffer))))
    }

    pub fn kill(&self) -> io::Result<bool> {
        if !self.is_alive()? {
            return Ok(false);
        }

        let raw_pid = libc::pid_t::try_from(self.pid).map_err(io::Error::other)?;
        // SAFETY: plain call; the start time check above names the process.
        if unsafe { libc::kill(raw_pid, libc::SIGKILL) } != 0 {
            let err = io::Error::last_os_error();
            return if err.raw_os_error() == Some(libc::ESRCH) {
                Ok(false)
            } else {
                Err(err)
            };
        }

        Ok(true)
    }

    pub fn kill_group(&self) -> io::Result<bool> {
        if !self.is_alive()? {
            return Ok(false);
        }

        let raw_pid = libc::pid_t::try_from(self.pid).map_err(io::Error::other)?;
        // SAFETY: plain call; the start time check above names the leader,
        // and a live leader pins the group id.
        if unsafe { libc::kill(-raw_pid, libc::SIGKILL) } != 0 {
            let err = io::Error::last_os_error();
            return if err.raw_os_error() == Some(libc::ESRCH) {
                Ok(false)
            } else {
                Err(err)
            };
        }

        Ok(true)
    }

    pub fn wait_for_exit(&self, timeout: Duration) -> io::Result<bool> {
        let deadline = Instant::now() + timeout;
        loop {
            if !self.is_alive()? {
                return Ok(true);
            }
            if Instant::now() >= deadline {
                return Ok(false);
            }

            thread::sleep(POLL_INTERVAL);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::environment_of;

    #[test]
    fn finds_the_environment_after_the_path_padding_and_arguments() {
        let mut procargs = 2_i32.to_ne_bytes().to_vec();
        procargs.extend_from_slice(b"/bin/sh\0\0\0\0sh\0-c\0A=1\0B=2\0\0\0");

        assert_eq!(environment_of(&procargs), Some(&b"A=1\0B=2\0\0\0"[..]));
    }

    #[test]
    fn rejects_a_truncated_buffer() {
        let mut procargs = 3_i32.to_ne_bytes().to_vec();
        procargs.extend_from_slice(b"/bin/sh\0\0sh\0");

        assert_eq!(environment_of(&procargs), None);
    }
}
