//! Windows trees: a named job with `KILL_ON_JOB_CLOSE`, given to
//! `CreateProcessW` through `PROC_THREAD_ATTRIBUTE_JOB_LIST`, so the worker
//! never exists outside its job. The worker starts suspended and resumes on
//! release. The reaper holds the only job handle: when the reaper dies, the
//! job closes and every process in it dies.

use std::ffi::{OsStr, c_void};
use std::fs::{File, OpenOptions};
use std::io;
use std::mem::{size_of, size_of_val, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use std::ptr::{null, null_mut};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    ERROR_ALREADY_EXISTS, FILETIME, GetLastError, HANDLE, HANDLE_FLAG_INHERIT,
    SetHandleInformation, WAIT_OBJECT_0,
};
use windows_sys::Win32::System::Console::{
    CTRL_BREAK_EVENT, GenerateConsoleCtrlEvent, GetConsoleProcessList,
};
use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject,
};
use windows_sys::Win32::System::Threading::{
    CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
    CreateProcessW, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT,
    GetExitCodeProcess, GetProcessTimes, INFINITE, InitializeProcThreadAttributeList,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    PROC_THREAD_ATTRIBUTE_JOB_LIST, PROCESS_INFORMATION, ResumeThread, STARTF_USESHOWWINDOW,
    STARTF_USESTDHANDLES, STARTUPINFOEXW, UpdateProcThreadAttribute, WaitForSingleObject,
};

use super::{ExitStatus, Finished, Inherit, Spec};

/// Exit code of a process ended by `TerminateJobObject`.
const KILLED_EXIT_CODE: u32 = 1;
/// `SW_HIDE`: the worker's window, if it makes one, starts hidden.
const SW_HIDE: u16 = 0;
/// How often [`Tree::finish`] checks the job's process count.
const POLL_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Debug)]
pub struct Tree {
    job: OwnedHandle,
    process: OwnedHandle,
    /// The suspended main thread until release.
    thread: Mutex<Option<OwnedHandle>>,
    pid: u32,
    start: u64,
}

fn wide(text: &OsStr) -> Vec<u16> {
    text.encode_wide().chain(Some(0)).collect()
}

fn check(ok: i32) -> io::Result<()> {
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn raw(handle: &impl AsRawHandle) -> HANDLE {
    handle.as_raw_handle().cast()
}

/// Append one argument the way the Microsoft C runtime reads it back.
fn push_argument(line: &mut String, argument: &str) {
    if !argument.is_empty() && !argument.contains([' ', '\t', '\n', '\x0b', '"']) {
        line.push_str(argument);
        return;
    }

    line.push('"');
    let mut backslashes = 0;
    for character in argument.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                line.push_str(&"\\".repeat(backslashes * 2 + 1));
                line.push('"');
                backslashes = 0;
            }
            _ => {
                line.push_str(&"\\".repeat(backslashes));
                line.push(character);
                backslashes = 0;
            }
        }
    }
    line.push_str(&"\\".repeat(backslashes * 2));
    line.push('"');
}

/// The command line: the quoted program, then the arguments.
pub(super) fn command_line(file: &Path, args: &[String], verbatim: bool) -> String {
    let mut line = format!("\"{}\"", file.display());
    for argument in args {
        line.push(' ');
        if verbatim {
            line.push_str(argument);
        } else {
            push_argument(&mut line, argument);
        }
    }
    line
}

/// `K=V\0...\0\0`, as `CREATE_UNICODE_ENVIRONMENT` reads it.
fn environment_block(env: &[(String, String)]) -> Vec<u16> {
    let mut block: Vec<u16> = Vec::new();
    for (name, value) in env {
        block.extend(OsStr::new(&format!("{name}={value}")).encode_wide());
        block.push(0);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    block
}

fn inheritable(file: File) -> io::Result<File> {
    // SAFETY: the handle is open and owned by `file`.
    check(unsafe { SetHandleInformation(raw(&file), HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) })?;
    Ok(file)
}

fn create_job(name: &str) -> io::Result<OwnedHandle> {
    let name = wide(OsStr::new(name));
    // SAFETY: default security, a valid name; the result is checked.
    let job = unsafe { CreateJobObjectW(null(), name.as_ptr()) };
    if job.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `CreateJobObjectW` returned a new handle nothing else owns.
    let job = unsafe { OwnedHandle::from_raw_handle(job.cast()) };
    // SAFETY: plain call right after the create.
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        return Err(io::Error::other(format!(
            "a job named {} already exists",
            String::from_utf16_lossy(&name)
        )));
    }

    // SAFETY: all-zero is a valid value of this plain struct.
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: the job is open; the struct and its size match the class.
    check(unsafe {
        SetInformationJobObject(
            raw(&job),
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast(),
            u32::try_from(size_of_val(&limits)).expect("struct size fits in u32"),
        )
    })?;
    Ok(job)
}

/// A `PROC_THREAD_ATTRIBUTE_LIST` in an aligned buffer.
struct AttributeList {
    buffer: Vec<usize>,
}

impl AttributeList {
    fn new(count: u32) -> io::Result<Self> {
        let mut size = 0;
        // SAFETY: a size query with a null list; it fails by design.
        unsafe { InitializeProcThreadAttributeList(null_mut(), count, 0, &mut size) };
        let mut list = Self {
            buffer: vec![0; size.div_ceil(size_of::<usize>())],
        };
        // SAFETY: the buffer holds at least `size` bytes.
        check(unsafe { InitializeProcThreadAttributeList(list.as_ptr(), count, 0, &mut size) })?;
        Ok(list)
    }

    fn as_ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.buffer.as_mut_ptr().cast()
    }

    /// # Safety
    ///
    /// `value` must stay valid until the list is dropped.
    unsafe fn set(
        &mut self,
        attribute: usize,
        value: *const c_void,
        size: usize,
    ) -> io::Result<()> {
        // SAFETY: the caller keeps `value` alive; the list is initialized.
        check(unsafe {
            UpdateProcThreadAttribute(self.as_ptr(), 0, attribute, value, size, null_mut(), null())
        })
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        // SAFETY: the list was initialized in `new`.
        unsafe { DeleteProcThreadAttributeList(self.as_ptr()) };
    }
}

fn has_console() -> bool {
    let mut pids = [0_u32; 1];
    // SAFETY: a one-element buffer; the count is its length.
    unsafe { GetConsoleProcessList(pids.as_mut_ptr(), 1) != 0 }
}

fn creation_time(process: &OwnedHandle) -> io::Result<u64> {
    let mut times = [FILETIME::default(); 4];
    let [creation, exit, kernel, user] = &mut times;
    // SAFETY: the handle is open; the out pointers are valid locals.
    check(unsafe { GetProcessTimes(raw(process), creation, exit, kernel, user) })?;
    Ok((u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
}

impl Tree {
    pub fn spawn(spec: &Spec, _inherit: &Inherit) -> io::Result<Self> {
        let job = create_job(&spec.job_name)?;
        let stdin = inheritable(File::open("NUL")?)?;
        let output = inheritable(match &spec.log {
            Some(log) => OpenOptions::new().append(true).create(true).open(log)?,
            None => OpenOptions::new().write(true).open("NUL")?,
        })?;

        let job_list = [raw(&job)];
        let handles = [raw(&stdin), raw(&output)];
        let mut attributes = AttributeList::new(2)?;
        // SAFETY: both arrays outlive `attributes`, which is dropped at the
        // end of this function, after `CreateProcessW`.
        unsafe {
            attributes.set(
                PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                job_list.as_ptr().cast(),
                size_of_val(&job_list),
            )?;
            attributes.set(
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_ptr().cast(),
                size_of_val(&handles),
            )?;
        }

        // SAFETY: all-zero is a valid value of this plain struct.
        let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
        startup.StartupInfo.cb = u32::try_from(size_of::<STARTUPINFOEXW>()).expect("fits");
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
        startup.StartupInfo.wShowWindow = SW_HIDE;
        startup.StartupInfo.hStdInput = raw(&stdin);
        startup.StartupInfo.hStdOutput = raw(&output);
        startup.StartupInfo.hStdError = raw(&output);
        startup.lpAttributeList = attributes.as_ptr();

        // Workers share the reaper's console, so `CTRL_BREAK` reaches their
        // group. A reaper with no console gives them none (no window pops
        // up); they then only get the forced stop.
        let mut flags = EXTENDED_STARTUPINFO_PRESENT
            | CREATE_NEW_PROCESS_GROUP
            | CREATE_UNICODE_ENVIRONMENT
            | CREATE_SUSPENDED;
        if !has_console() {
            flags |= CREATE_NO_WINDOW;
        }

        let application = wide(spec.file.as_os_str());
        let mut line = wide(OsStr::new(&command_line(
            &spec.file,
            &spec.args,
            spec.verbatim,
        )));
        let environment = environment_block(&spec.env);
        let cwd = wide(spec.cwd.as_os_str());
        // SAFETY: all-zero is a valid value of this plain struct.
        let mut info: PROCESS_INFORMATION = unsafe { zeroed() };
        // SAFETY: every pointer is a valid, NUL-terminated local that
        // outlives the call; the handle list names inheritable handles.
        check(unsafe {
            CreateProcessW(
                application.as_ptr(),
                line.as_mut_ptr(),
                null(),
                null(),
                1,
                flags,
                environment.as_ptr().cast(),
                cwd.as_ptr(),
                &raw const startup.StartupInfo,
                &raw mut info,
            )
        })?;
        drop(attributes);

        // SAFETY: `CreateProcessW` returned new handles nothing else owns.
        let (process, thread) = unsafe {
            (
                OwnedHandle::from_raw_handle(info.hProcess.cast()),
                OwnedHandle::from_raw_handle(info.hThread.cast()),
            )
        };
        let start = creation_time(&process)?;
        Ok(Self {
            job,
            process,
            thread: Mutex::new(Some(thread)),
            pid: info.dwProcessId,
            start,
        })
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn start_time(&self) -> u64 {
        self.start
    }

    pub fn release(&self) {
        let thread = self.thread.lock().expect("unpoisoned").take();
        if let Some(thread) = thread {
            // SAFETY: the handle is the suspended main thread.
            if unsafe { ResumeThread(raw(&thread)) } == u32::MAX {
                eprintln!(
                    "forge-reaper: resume worker {}: {}",
                    self.pid,
                    io::Error::last_os_error()
                );
            }
        }
    }

    pub fn signal_graceful(&self) -> io::Result<()> {
        // SAFETY: plain call; the group id is the worker's PID, never 0.
        check(unsafe { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, self.pid) })
    }

    pub fn kill(&self) -> io::Result<()> {
        // SAFETY: the job handle is open and has terminate access.
        check(unsafe { TerminateJobObject(raw(&self.job), KILLED_EXIT_CODE) })
    }

    pub fn wait_leader(&self) -> io::Result<()> {
        // SAFETY: the process handle is open and has `SYNCHRONIZE` access.
        match unsafe { WaitForSingleObject(raw(&self.process), INFINITE) } {
            WAIT_OBJECT_0 => Ok(()),
            _ => Err(io::Error::last_os_error()),
        }
    }

    fn active_processes(&self) -> io::Result<u32> {
        // SAFETY: all-zero is a valid value of this plain struct.
        let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
        // SAFETY: the job is open; the struct and its size match the class.
        check(unsafe {
            QueryInformationJobObject(
                raw(&self.job),
                JobObjectBasicAccountingInformation,
                (&raw mut accounting).cast(),
                u32::try_from(size_of_val(&accounting)).expect("struct size fits in u32"),
                null_mut(),
            )
        })?;
        Ok(accounting.ActiveProcesses)
    }

    pub fn finish(&self, bound: Duration) -> io::Result<Finished> {
        let mut code = 0_u32;
        // SAFETY: the process handle is open; `code` is a valid local.
        check(unsafe { GetExitCodeProcess(raw(&self.process), &mut code) })?;
        let status = ExitStatus {
            code: Some(code.cast_signed()),
            signal: None,
        };

        let deadline = Instant::now() + bound;
        loop {
            if self.active_processes()? == 0 {
                return Ok(Finished {
                    status,
                    empty: true,
                    survivors: Vec::new(),
                });
            }
            if Instant::now() >= deadline {
                return Ok(Finished {
                    status,
                    empty: false,
                    survivors: Vec::new(),
                });
            }
            thread::sleep(POLL_INTERVAL);
        }
    }
}

/// Jobs own every descendant from creation: nothing to set up.
pub fn become_owner() -> io::Result<()> {
    Ok(())
}

/// Jobs kill every descendant: no orphan outlives its tree.
pub fn sweep_orphans(_bound: Duration) -> io::Result<Vec<u32>> {
    Ok(Vec::new())
}
