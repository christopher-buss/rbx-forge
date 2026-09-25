//! Windows measurements: job breakaway per host, and named-pipe remote
//! rejection plus DACL.

use std::ffi::c_void;
use std::io::Write;
use std::mem::{size_of, zeroed};
use std::ptr::{null, null_mut};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::*;
use windows_sys::core::{BOOL, PWSTR};
use windows_sys::Win32::Security::Authorization::*;
use windows_sys::Win32::Security::*;
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::JobObjects::*;
use windows_sys::Win32::System::Pipes::*;
use windows_sys::Win32::System::Threading::*;

fn w(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

unsafe fn from_wide(p: *const u16) -> String {
    let mut n = 0;
    while unsafe { *p.add(n) } != 0 {
        n += 1;
    }
    String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(p, n) })
}

fn exe() -> String {
    std::env::current_exe().unwrap().display().to_string()
}

pub fn run(args: &[String]) {
    let cmd = args.get(1).map(String::as_str).unwrap_or("");
    match cmd {
        "probe" => {
            let secs: u32 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(30);
            let out = probe(secs);
            match args.get(2).filter(|p| p.as_str() != "-") {
                Some(path) => std::fs::write(path, &out).unwrap(),
                None => print!("{out}"),
            }
        }
        "via-parent" => via_parent(args[2].parse().unwrap(), &args[3]),
        "synthetic" => synthetic(),
        "validate-via-parent" => validate_via_parent(&args[2]),
        "alive" => {
            for pid in &args[2..] {
                let pid: u32 = pid.parse().unwrap();
                println!("pid={pid} alive={}", alive(pid));
            }
        }
        "sleep" => std::thread::sleep(Duration::from_secs(args[2].parse().unwrap())),
        "pipe" => pipe(),
        _ => eprintln!("usage: spike36 probe|via-parent|synthetic|alive|sleep|pipe"),
    }
}

// ---------------------------------------------------------------- breakaway

fn job_report() -> String {
    unsafe {
        let mut in_job: BOOL = 0;
        IsProcessInJob(GetCurrentProcess(), null_mut(), &mut in_job);
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
        let ok = QueryInformationJobObject(
            null_mut(),
            JobObjectExtendedLimitInformation,
            &mut info as *mut _ as *mut c_void,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            null_mut(),
        );
        let err = if ok == 0 { GetLastError() } else { 0 };
        let mut acct: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = zeroed();
        QueryInformationJobObject(
            null_mut(),
            JobObjectBasicAccountingInformation,
            &mut acct as *mut _ as *mut c_void,
            size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
            null_mut(),
        );
        let f = info.BasicLimitInformation.LimitFlags;
        format!(
            "self pid={} in_job={} query_err={} limit_flags=0x{:x} kill_on_close={} breakaway_ok={} silent_breakaway_ok={} job_active_processes={}\n",
            GetCurrentProcessId(),
            in_job != 0,
            err,
            f,
            f & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE != 0,
            f & JOB_OBJECT_LIMIT_BREAKAWAY_OK != 0,
            f & JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK != 0,
            acct.ActiveProcesses,
        )
    }
}

struct AttrList {
    buf: Vec<u8>,
}

impl AttrList {
    unsafe fn new(attr: usize, value: *const c_void, size: usize) -> Self {
        unsafe {
            let mut sz = 0usize;
            InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut sz);
            let mut buf = vec![0u8; sz];
            let p = buf.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
            assert!(InitializeProcThreadAttributeList(p, 1, 0, &mut sz) != 0);
            assert!(UpdateProcThreadAttribute(p, 0, attr, value, size, null_mut(), null()) != 0);
            AttrList { buf }
        }
    }

    fn ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.buf.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST
    }
}

fn spawn(
    cmdline: &str,
    flags: PROCESS_CREATION_FLAGS,
    attrs: Option<&mut AttrList>,
) -> Result<PROCESS_INFORMATION, u32> {
    unsafe {
        let mut cmd = w(cmdline);
        let mut si: STARTUPINFOEXW = zeroed();
        si.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        let mut f = flags;
        if let Some(a) = attrs {
            si.lpAttributeList = a.ptr();
            f |= EXTENDED_STARTUPINFO_PRESENT;
        }
        let mut pi: PROCESS_INFORMATION = zeroed();
        let ok = CreateProcessW(
            null(),
            cmd.as_mut_ptr(),
            null(),
            null(),
            0,
            f,
            null(),
            null(),
            &si.StartupInfo,
            &mut pi,
        );
        if ok == 0 { Err(GetLastError()) } else { Ok(pi) }
    }
}

fn in_any_job(h: HANDLE) -> bool {
    let mut b: BOOL = 0;
    unsafe { IsProcessInJob(h, null_mut(), &mut b) };
    b != 0
}

fn probe(secs: u32) -> String {
    let mut out = job_report();
    let sleeper = format!("\"{}\" sleep {secs}", exe());
    let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
    for (label, flags) in [
        ("detached", base),
        ("detached+breakaway", base | CREATE_BREAKAWAY_FROM_JOB),
    ] {
        match spawn(&sleeper, flags, None) {
            Ok(pi) => {
                out += &format!(
                    "attempt={label} ok=true pid={} child_in_job={}\n",
                    pi.dwProcessId,
                    in_any_job(pi.hProcess)
                );
                unsafe {
                    CloseHandle(pi.hProcess);
                    CloseHandle(pi.hThread);
                }
            }
            Err(e) => out += &format!("attempt={label} ok=false err={e}\n"),
        }
    }
    out
}

/// Runs `probe` as a child of another process (for example a VS Code
/// terminal shell). A child created with PROC_THREAD_ATTRIBUTE_PARENT_PROCESS
/// inherits that parent's job, so the probe sees the host's job.
fn via_parent(pid: u32, out: &str) {
    unsafe {
        let hp = OpenProcess(
            PROCESS_CREATE_PROCESS | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            pid,
        );
        if hp.is_null() {
            println!("host pid={pid} open_err={}", GetLastError());
            return;
        }
        println!("host pid={pid} host_in_job={}", in_any_job(hp));
        let mut list = AttrList::new(
            PROC_THREAD_ATTRIBUTE_PARENT_PROCESS as usize,
            &hp as *const HANDLE as *const c_void,
            size_of::<HANDLE>(),
        );
        let cmd = format!("\"{}\" probe \"{out}\" 30", exe());
        match spawn(&cmd, CREATE_NO_WINDOW, Some(&mut list)) {
            Ok(pi) => {
                WaitForSingleObject(pi.hProcess, 15_000);
                print!("{}", std::fs::read_to_string(out).unwrap_or_default());
            }
            Err(e) => println!("spawn_err={e}"),
        }
    }
}

/// Checks that `via-parent` really puts the probe in the parent's job: the
/// parent is a sleeper inside a forge-made job with no breakaway rights.
fn validate_via_parent(out: &str) {
    for (label, extra) in [
        ("kill_on_close", 0),
        ("kill_on_close+silent_breakaway_ok", JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK),
    ] {
        unsafe {
            let job = CreateJobObjectW(null(), null());
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | extra;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            let mut list = AttrList::new(
                PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                &job as *const HANDLE as *const c_void,
                size_of::<HANDLE>(),
            );
            let pi = spawn(&format!("\"{}\" sleep 30", exe()), CREATE_NO_WINDOW, Some(&mut list)).unwrap();
            println!("== parent in job {label}");
            via_parent(pi.dwProcessId, out);
            CloseHandle(job);
        }
    }
}

fn alive(pid: u32) -> bool {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut code = 0u32;
        GetExitCodeProcess(h, &mut code);
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(h);
        let name = String::from_utf16_lossy(&buf[..len as usize]);
        code == STILL_ACTIVE as u32 && name.ends_with("spike36.exe")
    }
}

/// Runs the probe inside forge-made jobs with known limits, then closes the
/// job and checks which sleepers survived.
fn synthetic() {
    for (label, extra) in [
        ("kill_on_close", 0),
        ("kill_on_close+breakaway_ok", JOB_OBJECT_LIMIT_BREAKAWAY_OK),
        (
            "kill_on_close+silent_breakaway_ok",
            JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
        ),
    ] {
        unsafe {
            let job = CreateJobObjectW(null(), null());
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | extra;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            let mut list = AttrList::new(
                PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                &job as *const HANDLE as *const c_void,
                size_of::<HANDLE>(),
            );
            let out = std::env::temp_dir().join(format!("spike36-syn-{}.txt", std::process::id()));
            let cmd = format!("\"{}\" probe \"{}\" 30", exe(), out.display());
            println!("== job {label}");
            match spawn(&cmd, CREATE_NO_WINDOW, Some(&mut list)) {
                Ok(pi) => {
                    WaitForSingleObject(pi.hProcess, 15_000);
                    let text = std::fs::read_to_string(&out).unwrap_or_default();
                    print!("{text}");
                    CloseHandle(job);
                    std::thread::sleep(Duration::from_millis(500));
                    for tok in text.split_whitespace() {
                        if let Some(p) = tok.strip_prefix("pid=") {
                            let p: u32 = p.parse().unwrap();
                            if p != pi.dwProcessId {
                                println!("after_job_close pid={p} alive={}", alive(p));
                            }
                        }
                    }
                }
                Err(e) => println!("spawn_err={e}"),
            }
        }
    }
}

// --------------------------------------------------------------------- pipe

fn user_sid() -> String {
    unsafe {
        let mut tok: HANDLE = null_mut();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut tok);
        let mut len = 0u32;
        GetTokenInformation(tok, TokenUser, null_mut(), 0, &mut len);
        let mut buf = vec![0u8; len as usize];
        GetTokenInformation(tok, TokenUser, buf.as_mut_ptr() as *mut c_void, len, &mut len);
        let tu = &*(buf.as_ptr() as *const TOKEN_USER);
        let mut s: PWSTR = null_mut();
        ConvertSidToStringSidW(tu.User.Sid, &mut s);
        let out = from_wide(s);
        LocalFree(s as HLOCAL);
        out
    }
}

fn create_pipe(name: &str, first: bool, reject: bool, sa: *const SECURITY_ATTRIBUTES) -> Result<HANDLE, u32> {
    unsafe {
        let open = PIPE_ACCESS_DUPLEX | if first { FILE_FLAG_FIRST_PIPE_INSTANCE } else { 0 };
        let mode = PIPE_TYPE_BYTE
            | PIPE_READMODE_BYTE
            | PIPE_WAIT
            | if reject { PIPE_REJECT_REMOTE_CLIENTS } else { PIPE_ACCEPT_REMOTE_CLIENTS };
        let h = CreateNamedPipeW(w(name).as_ptr(), open, mode, PIPE_UNLIMITED_INSTANCES, 4096, 4096, 0, sa);
        if h == INVALID_HANDLE_VALUE { Err(GetLastError()) } else { Ok(h) }
    }
}

/// Opens a pipe client on a thread with a timeout, optionally as the
/// anonymous user.
fn connect(path: String, anonymous: bool) -> String {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || unsafe {
        if anonymous {
            ImpersonateAnonymousToken(GetCurrentThread());
        }
        let start = Instant::now();
        let h = CreateFileW(
            w(&path).as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            null(),
            OPEN_EXISTING,
            0,
            null_mut(),
        );
        let res = if h == INVALID_HANDLE_VALUE {
            format!("ok=false err={}", GetLastError())
        } else {
            CloseHandle(h);
            "ok=true".to_owned()
        };
        if anonymous {
            RevertToSelf();
        }
        let _ = tx.send(format!("{res} ms={}", start.elapsed().as_millis()));
    });
    rx.recv_timeout(Duration::from_secs(20))
        .unwrap_or_else(|_| "timeout(20s)".to_owned())
}

fn pipe() {
    let sid = user_sid();
    let host = std::env::var("COMPUTERNAME").unwrap_or_default();
    println!("user_sid={sid} computer={host}");
    let sddl = format!("O:{sid}D:P(A;;GA;;;{sid})");
    let mut psd: PSECURITY_DESCRIPTOR = null_mut();
    unsafe {
        assert!(
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                w(&sddl).as_ptr(),
                SDDL_REVISION_1,
                &mut psd,
                null_mut()
            ) != 0
        );
    }
    let sa = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: psd,
        bInheritHandle: 0,
    };
    let mut keep = Vec::new();
    for (label, reject, sa_ptr) in [
        ("reject_remote+user_dacl", true, &sa as *const SECURITY_ATTRIBUTES),
        ("accept_remote+user_dacl(control)", false, &sa as *const _),
        ("reject_remote+default_dacl(control)", true, null()),
    ] {
        let name = format!("rbx-forge-spike36-{}-{}", std::process::id(), keep.len());
        let local = format!(r"\\.\pipe\{name}");
        println!("== pipe {label} name={local}");
        let first = create_pipe(&local, true, reject, sa_ptr).expect("first instance");
        keep.push(first);
        println!(
            "second_first_instance_create={}",
            match create_pipe(&local, true, reject, sa_ptr) {
                Ok(h) => {
                    keep.push(h);
                    "ok (UNEXPECTED)".to_owned()
                }
                Err(e) => format!("err={e}"),
            }
        );
        unsafe {
            let mut sd: PSECURITY_DESCRIPTOR = null_mut();
            let mut dacl: *mut ACL = null_mut();
            let mut owner: PSID = null_mut();
            GetSecurityInfo(
                first,
                SE_KERNEL_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut sd,
            );
            let mut s: PWSTR = null_mut();
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                sd,
                SDDL_REVISION_1,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut s,
                null_mut(),
            );
            println!("sddl_readback={}", from_wide(s));
        }
        let targets = [
            (local.clone(), false),
            (format!(r"\\127.0.0.1\pipe\{name}"), false),
            (format!(r"\\localhost\pipe\{name}"), false),
            (format!(r"\\{host}\pipe\{name}"), false),
            (format!(r"\\--1.ipv6-literal.net\pipe\{name}"), false),
            (local.clone(), true),
        ];
        for (path, anon) in targets {
            // A fresh listening instance for every client.
            keep.push(create_pipe(&local, false, reject, sa_ptr).expect("instance"));
            let who = if anon { "anonymous" } else { "self" };
            println!("client={path} as={who} {}", connect(path.clone(), anon));
        }
    }
    let _ = std::io::stdout().flush();
}
