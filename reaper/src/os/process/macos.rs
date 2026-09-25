//! macOS: no pidfd, so the pin is the PID plus its start time, and every call
//! first checks that the PID still has that start time. A PID reused between
//! the check and the call (microseconds) is an accepted limit (spec #28).

use super::StartTime;
use std::ffi::OsStr;
use std::io;
use std::mem::{size_of, zeroed};
use std::os::unix::ffi::OsStrExt;
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant};

/// How often [`Pin::wait_for_exit`] checks the process.
const POLL_INTERVAL: Duration = Duration::from_millis(10);

/// Start time of a live process. `Ok(None)` when no process has this PID or
/// it is a zombie.
pub fn start_time(pid: u32) -> io::Result<Option<StartTime>> {
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
    if info.pbi_status == libc::SZOMB {
        return Ok(None);
    }

    Ok(Some(
        info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec,
    ))
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
