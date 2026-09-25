//! POSIX measurement: find marker-tagged processes of the same user by
//! scanning process environments (macOS `KERN_PROCARGS2`, Linux
//! `/proc/<pid>/environ`).

use std::collections::BTreeMap;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const SESSION: &str = "RBX_FORGE_SESSION";
const WORKER: &str = "RBX_FORGE_WORKER";

pub fn run(args: &[String]) {
    match args.get(1).map(String::as_str) {
        Some("envscan") => envscan(),
        Some("hold") => hold(args[2].parse().unwrap(), &args[3]),
        _ => eprintln!("usage: spike36 envscan|hold <secs> <mode>"),
    }
}

/// A worker that hides its marker after start, then sleeps.
fn hold(secs: u64, mode: &str) {
    match mode {
        // libc unsetenv: moves the `environ` array, leaves the strings.
        "unsetenv" => unsafe {
            std::env::remove_var(SESSION);
            std::env::remove_var(WORKER);
        },
        // Overwrite the original env strings in place.
        "overwrite" => unsafe {
            unsafe extern "C" {
                static mut environ: *mut *mut libc::c_char;
            }
            let mut p = environ;
            while !(*p).is_null() {
                let s = std::ffi::CStr::from_ptr(*p).to_bytes();
                if s.starts_with(b"RBX_FORGE_") {
                    std::ptr::write_bytes(*p, b'x', s.len());
                }
                p = p.add(1);
            }
        },
        _ => {}
    }
    std::thread::sleep(Duration::from_secs(secs));
}

struct Info {
    uid: u32,
    start: String,
}

#[cfg(target_os = "macos")]
mod os {
    use super::Info;
    use std::mem::{size_of, zeroed};
    use std::ptr::null_mut;

    pub fn pids() -> Vec<i32> {
        unsafe {
            let n = libc::proc_listallpids(null_mut(), 0);
            let mut v = vec![0i32; n as usize + 256];
            let n = libc::proc_listallpids(v.as_mut_ptr().cast(), (v.len() * 4) as i32);
            v.truncate(n.max(0) as usize);
            v
        }
    }

    pub fn info(pid: i32) -> Option<Info> {
        unsafe {
            let mut bi: libc::proc_bsdinfo = zeroed();
            let n = libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                (&mut bi as *mut libc::proc_bsdinfo).cast(),
                size_of::<libc::proc_bsdinfo>() as i32,
            );
            (n as usize == size_of::<libc::proc_bsdinfo>()).then(|| Info {
                uid: bi.pbi_uid,
                start: format!("{}.{:06}", bi.pbi_start_tvsec, bi.pbi_start_tvusec),
            })
        }
    }

    /// Environment strings of `pid` from KERN_PROCARGS2, or the errno.
    pub fn env(pid: i32) -> Result<Vec<String>, i32> {
        unsafe {
            let mut argmax: libc::c_int = 0;
            let mut size = size_of::<libc::c_int>();
            let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
            libc::sysctl(mib.as_mut_ptr(), 2, (&mut argmax as *mut i32).cast(), &mut size, null_mut(), 0);
            let mut buf = vec![0u8; argmax as usize];
            let mut size = buf.len();
            let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
            if libc::sysctl(mib.as_mut_ptr(), 3, buf.as_mut_ptr().cast(), &mut size, null_mut(), 0) != 0 {
                return Err(*libc::__error());
            }
            buf.truncate(size);
            Ok(parse(&buf))
        }
    }

    /// Layout: argc (i32), exec path, NUL padding, argv[argc], env..., "".
    fn parse(buf: &[u8]) -> Vec<String> {
        if buf.len() < 4 {
            return vec![];
        }
        let argc = i32::from_ne_bytes(buf[0..4].try_into().unwrap()) as usize;
        let mut pos = 4;
        while pos < buf.len() && buf[pos] != 0 {
            pos += 1;
        }
        while pos < buf.len() && buf[pos] == 0 {
            pos += 1;
        }
        let mut strings = buf[pos..].split(|b| *b == 0);
        for _ in 0..argc {
            strings.next();
        }
        strings
            .take_while(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .collect()
    }
}

#[cfg(target_os = "linux")]
mod os {
    use super::Info;
    use std::os::unix::fs::MetadataExt;

    pub fn pids() -> Vec<i32> {
        std::fs::read_dir("/proc")
            .unwrap()
            .filter_map(|e| e.ok()?.file_name().to_str()?.parse().ok())
            .collect()
    }

    pub fn info(pid: i32) -> Option<Info> {
        let uid = std::fs::metadata(format!("/proc/{pid}")).ok()?.uid();
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let after = &stat[stat.rfind(')')? + 2..];
        let start = after.split_whitespace().nth(19)?.to_owned();
        Some(Info { uid, start })
    }

    pub fn env(pid: i32) -> Result<Vec<String>, i32> {
        std::fs::read(format!("/proc/{pid}/environ"))
            .map(|b| {
                b.split(|c| *c == 0)
                    .filter(|s| !s.is_empty())
                    .map(|s| String::from_utf8_lossy(s).into_owned())
                    .collect()
            })
            .map_err(|e| e.raw_os_error().unwrap_or(-1))
    }
}

struct Hit {
    pid: i32,
    worker: String,
    start: String,
}

fn scan(session: &str) -> (Vec<Hit>, BTreeMap<String, usize>, Duration) {
    let me = unsafe { libc::getuid() };
    let t = Instant::now();
    let mut stats = BTreeMap::new();
    let mut hits = vec![];
    let want = format!("{SESSION}={session}");
    for pid in os::pids() {
        let Some(info) = os::info(pid) else {
            *stats.entry("info_unavailable".into()).or_default() += 1;
            continue;
        };
        let class = if info.uid == me { "same_uid" } else { "other_uid" };
        match os::env(pid) {
            Ok(env) => {
                *stats.entry(format!("{class}:readable")).or_default() += 1;
                if env.iter().any(|e| *e == want) {
                    let worker = env
                        .iter()
                        .find_map(|e| e.strip_prefix(&format!("{WORKER}=")).map(str::to_owned))
                        .unwrap_or_default();
                    hits.push(Hit { pid, worker, start: info.start });
                }
            }
            Err(e) => *stats.entry(format!("{class}:errno={e}")).or_default() += 1,
        }
    }
    (hits, stats, t.elapsed())
}

fn envscan() {
    let session = format!("spike36-{}", std::process::id());
    let exe = std::env::current_exe().unwrap();
    println!("os={} session={session}", std::env::consts::OS);
    let node = which("node");
    let mut scenarios: Vec<(&str, Command, bool)> = vec![];
    let mut c = Command::new("/bin/sleep");
    c.arg("60");
    scenarios.push(("platform_binary_sleep", c, true));
    let mut c = Command::new("/bin/sh");
    c.args(["-c", "/bin/sleep 60 & exit 0"]);
    scenarios.push(("orphaned_grandchild", c, true));
    let mut c = Command::new("/bin/sh");
    c.args(["-c", "( /bin/sleep 60 & ) ; exit 0"]);
    scenarios.push(("double_fork", c, true));
    let mut c = Command::new(&exe);
    c.args(["hold", "60", "unsetenv"]);
    scenarios.push(("unsetenv_in_process", c, true));
    let mut c = Command::new(&exe);
    c.args(["hold", "60", "overwrite"]);
    scenarios.push(("overwrite_in_place", c, false));
    let mut c = Command::new("/bin/sh");
    c.args(["-c", "unset RBX_FORGE_SESSION RBX_FORGE_WORKER; exec /bin/sleep 60"]);
    scenarios.push(("exec_with_scrubbed_env", c, false));
    if let Some(node) = node {
        let mut c = Command::new(node);
        c.args(["-e", "setTimeout(() => {}, 60000)"]);
        scenarios.push(("node_hardened_runtime", c, true));
    }
    let mut children = vec![];
    let mut expected = BTreeMap::new();
    for (name, mut cmd, expect) in scenarios {
        cmd.env(SESSION, &session)
            .env(WORKER, name)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        children.push(cmd.spawn().unwrap());
        expected.insert(name, expect);
    }
    std::thread::sleep(Duration::from_millis(1000));
    for pass in 1..=3 {
        let (hits, stats, took) = scan(&session);
        println!("pass={pass} scan_ms={:.1} stats={stats:?}", took.as_secs_f64() * 1000.0);
        if pass == 3 {
            for h in &hits {
                println!("hit pid={} worker={} start={}", h.pid, h.worker, h.start);
            }
            for (name, expect) in &expected {
                let found = hits.iter().any(|h| h.worker == *name);
                println!(
                    "scenario={name} found={found} expected={expect} {}",
                    if found == *expect { "OK" } else { "MISMATCH" }
                );
            }
            // Clean up: verify start time again, then kill.
            for h in &hits {
                let same = os::info(h.pid).map(|i| i.start == h.start).unwrap_or(false);
                if same {
                    unsafe { libc::kill(h.pid, libc::SIGKILL) };
                }
            }
        }
    }
    for mut c in children {
        let _ = c.kill();
        let _ = c.wait();
    }
    // The scrubbed/overwritten ones are not found by marker; kill leftovers by name.
    let _ = Command::new("pkill").args(["-f", "spike36 hold"]).status();
}

fn which(bin: &str) -> Option<std::path::PathBuf> {
    std::env::var_os("PATH").and_then(|p| {
        std::env::split_paths(&p)
            .map(|d| d.join(bin))
            .find(|p| p.is_file())
    })
}
