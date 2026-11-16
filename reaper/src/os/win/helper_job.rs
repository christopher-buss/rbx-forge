//! Match libuv's inner breakaway job for a directly interop-started helper.
use std::io;
use std::mem::{size_of_val, zeroed};
use std::os::windows::io::OwnedHandle;
use std::ptr::{null, null_mut};
use std::sync::Mutex;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject,
};
use windows_sys::Win32::System::Threading::GetCurrentProcess;

use super::{check, owned, raw};

static JOB: Mutex<Option<OwnedHandle>> = Mutex::new(None);

pub fn prepare() -> io::Result<()> {
    let mut slot = JOB
        .lock()
        .map_err(|_| io::Error::other("Windows helper job lock poisoned"))?;
    if slot.is_some() {
        return Ok(());
    }
    let mut in_job = 0;
    // SAFETY: current-process pseudo handle and writable BOOL.
    check(unsafe { IsProcessInJob(GetCurrentProcess(), null_mut(), &raw mut in_job) })?;
    if in_job == 0 {
        return Ok(());
    }
    // SAFETY: zero is valid for this information struct.
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    let bytes = u32::try_from(size_of_val(&limits)).expect("fits in u32");
    // SAFETY: null selects this process's job; buffer and class agree.
    check(unsafe {
        QueryInformationJobObject(
            null_mut(),
            JobObjectExtendedLimitInformation,
            (&raw mut limits).cast(),
            bytes,
            null_mut(),
        )
    })?;
    let flags = limits.BasicLimitInformation.LimitFlags;
    if flags
        & (JOB_OBJECT_LIMIT_BREAKAWAY_OK
            | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK
            | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
        != 0
    {
        return Ok(());
    }
    // Preserve every host limit; only our new inner job permits breakaway.
    let job = owned(unsafe { CreateJobObjectW(null(), null()) }, null_mut())?;
    limits = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
    // SAFETY: owned job and matching information buffer.
    check(unsafe {
        SetInformationJobObject(
            raw(&job),
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast(),
            bytes,
        )
    })?;
    // SAFETY: owned job; only this helper joins it.
    check(unsafe { AssignProcessToJobObject(raw(&job), GetCurrentProcess()) })?;
    *slot = Some(job);
    Ok(())
}
