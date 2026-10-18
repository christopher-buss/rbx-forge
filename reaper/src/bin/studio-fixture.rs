//! Studio's launch arguments, lock, and close behavior without opening Studio.
//! A marker's ReadyUrl receives one GET after the place lock exists.
//! FIXTURE_STUDIO_ACK=none omits the GET; wrong sends an invalid token.
//! FIXTURE_STUDIO_ACK_DELAY_MS delays the GET from the lock's creation.
//! FIXTURE_STUDIO_PLATFORM_LAUNCHER=1 reads the place from RBX_FORGE_PLACE.
//! FIXTURE_STUDIO_DIALOG_TRIGGER gates the prompt on a file's creation.
//! FIXTURE_STUDIO_DIALOG_READY_FILE records when the prompt opens.
//! FIXTURE_STUDIO_CAPTURE_MODEL posts that binary model with CAPTURE_SERVICES JSON.
//! FIXTURE_STUDIO_CAPTURE_ROJO_PORT overrides the marker's Rojo Port.
//! FIXTURE_STUDIO_CAPTURE=timeout polls without posting; disconnect omits polling.
//! FIXTURE_STUDIO_CAPTURE_DELAY_MS delays posts; CAPTURE_ERROR posts a code or JSON error.

#[allow(
    dead_code,
    unfulfilled_lint_expectations,
    reason = "the addon and reaper use the rest of the os layer"
)]
#[cfg(windows)]
#[path = "../os/mod.rs"]
mod os;

use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn main() -> io::Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    let platform_place = (env::var("FIXTURE_STUDIO_PLATFORM_LAUNCHER").as_deref() == Ok("1"))
        .then(|| env::var("RBX_FORGE_PLACE"))
        .transpose()
        .map_err(io::Error::other)?;
    let place = platform_place
        .as_deref()
        .or_else(|| {
            args.windows(2)
                .find(|pair| pair[0] == "--localPlaceFile")
                .map(|pair| pair[1].as_str())
                .or_else(|| args.first().map(String::as_str))
        })
        .ok_or_else(|| io::Error::other("missing place"))?;
    let marker_script = args
        .windows(2)
        .find(|pair| pair[0] == "--runScriptFile")
        .map(|script| fs::read_to_string(&script[1]))
        .transpose()?
        .unwrap_or_default();
    let mut ready_url = marker_attribute(&marker_script, "ReadyUrl");
    if env::var("FIXTURE_STUDIO_ACK").as_deref() == Ok("none") {
        ready_url = None;
    } else if env::var("FIXTURE_STUDIO_ACK").as_deref() == Ok("wrong") {
        ready_url = ready_url.map(|url| url.replacen("/ready/", "/ready/wrong-", 1));
    }
    let window = open_main_window(place)?;
    #[cfg(windows)]
    if env::var("FIXTURE_STUDIO_HIDE_WINDOWS").as_deref() == Ok("1") {
        os::process::PinnedProcess::open(std::process::id())?
            .ok_or_else(|| io::Error::other("fixture exited"))?
            .start_window_hiding()?;
        if let Ok(trigger) = env::var("FIXTURE_STUDIO_WINDOW_TRIGGER") {
            fs::write(format!("{trigger}.watching"), "")?;
        }
    }
    install_close_handler();
    record_start(&args)?;
    start_capture(&marker_script);
    let lock = format!("{place}.lock");
    let started = Instant::now();
    let lock_delay = env::var("FIXTURE_STUDIO_LOCK_DELAY_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let mut lock_pending = env::var("FIXTURE_STUDIO_LOCK").as_deref() == Ok("1");
    let ack_delay = Duration::from_millis(
        env::var("FIXTURE_STUDIO_ACK_DELAY_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0),
    );
    let mut locked_at = None;
    if lock_pending && env::var("FIXTURE_STUDIO_AUTOSAVE").as_deref() == Ok("1") {
        write_autosave(Path::new(place))?;
    }
    let dialog_delay = env::var("FIXTURE_STUDIO_DIALOG_DELAY_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok());
    let dialog_trigger = env::var("FIXTURE_STUDIO_DIALOG_TRIGGER").ok();
    let mut dialog_opened = false;
    let mut handled_close = 0;
    let mut extra_window_opened = false;
    #[cfg(windows)]
    let mut extra_window = None;
    loop {
        if !extra_window_opened
            && let Ok(trigger) = env::var("FIXTURE_STUDIO_WINDOW_TRIGGER")
            && Path::new(&trigger).exists()
        {
            #[cfg(windows)]
            {
                extra_window = Some(os::win::testing::open_test_window(
                    "fixture new window",
                    true,
                )?);
            }
            fs::write(format!("{trigger}.created"), "")?;
            extra_window_opened = true;
        }
        #[cfg(windows)]
        if let Some(window) = extra_window
            && let Ok(trigger) = env::var("FIXTURE_STUDIO_WINDOW_TRIGGER")
        {
            // SAFETY: the fixture owns this window until its process exits.
            let visible = unsafe {
                windows_sys::Win32::UI::WindowsAndMessaging::IsWindowVisible(window as _)
            } != 0;
            fs::write(format!("{trigger}.visible"), visible.to_string())?;
        }
        if lock_pending && started.elapsed() >= Duration::from_millis(lock_delay) {
            fs::write(
                &lock,
                format!(
                    "{}\nRobloxStudioBeta\n{}\n00000000-0000-0000-0000-000000000000\n",
                    std::process::id(),
                    env::var("FIXTURE_STUDIO_HOSTNAME").unwrap_or_default(),
                ),
            )?;
            lock_pending = false;
            locked_at = Some(Instant::now());
        }
        if !dialog_opened
            && dialog_delay.is_some_and(|ms| started.elapsed() >= Duration::from_millis(ms))
            && dialog_trigger
                .as_ref()
                .is_none_or(|file| Path::new(file).exists())
        {
            open_dialog(window)?;
            dialog_opened = true;
            if let Ok(file) = env::var("FIXTURE_STUDIO_DIALOG_READY_FILE") {
                fs::write(
                    file,
                    serde_json::json!({
                        "at": SystemTime::now().duration_since(UNIX_EPOCH).expect("after epoch").as_millis(),
                        "pid": std::process::id(),
                    }).to_string(),
                )?;
            }
        }
        let requests = close_requests();
        if requests > handled_close {
            handled_close = requests;
            match env::var("FIXTURE_STUDIO_CLOSE").as_deref() {
                Ok("dialog") => disable_window(window),
                Ok("refuse") => (),
                Ok("linger") => {
                    let _ = fs::remove_file(&lock);
                }
                _ => {
                    let _ = fs::remove_file(&lock);
                    return Ok(());
                }
            }
        }
        if locked_at.is_some_and(|opened: Instant| opened.elapsed() >= ack_delay)
            && Path::new(&lock).exists()
            && let Some(url) = ready_url.take()
        {
            // Callback transport cannot stall the Studio close loop.
            thread::spawn(move || {
                let _ = acknowledge(&url);
            });
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn marker_attribute(script: &str, attribute: &str) -> Option<String> {
    script.split(":SetAttribute(").find_map(|setter| {
        let (name, value) = setter.split_once(',')?;
        if name.trim() != format!("\"{attribute}\"") {
            return None;
        }
        serde_json::Deserializer::from_str(value.trim_start())
            .into_iter::<String>()
            .next()?
            .ok()
    })
}

enum CaptureLocation {
    Rojo(u16),
    Snapshot(String),
}

fn start_capture(marker_script: &str) {
    let model = env::var("FIXTURE_STUDIO_CAPTURE_MODEL").ok();
    let mode = env::var("FIXTURE_STUDIO_CAPTURE").unwrap_or_default();
    let error = env::var("FIXTURE_STUDIO_CAPTURE_ERROR").ok();
    if model.is_none() && mode.is_empty() && error.is_none() {
        return;
    }
    let port = env::var("FIXTURE_STUDIO_CAPTURE_ROJO_PORT")
        .ok()
        .or_else(|| marker_attribute(marker_script, "Port"))
        .and_then(|value| value.parse::<u16>().ok());
    let location = match marker_attribute(marker_script, "CaptureUrl") {
        Some(url) => CaptureLocation::Snapshot(url),
        None => match port {
            Some(port) => CaptureLocation::Rojo(port),
            None => return,
        },
    };
    let services = env::var("FIXTURE_STUDIO_CAPTURE_SERVICES")
        .unwrap_or_else(|_| r#"[{"name":"ServerScriptService","roots":[0]}]"#.to_owned());
    let delay = Duration::from_millis(
        env::var("FIXTURE_STUDIO_CAPTURE_DELAY_MS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(0),
    );
    // Capture I/O cannot stall the Studio close loop.
    thread::spawn(move || {
        let Ok(services) = serde_json::from_str::<serde_json::Value>(&services) else {
            return;
        };
        loop {
            if mode != "disconnect" {
                let _ = poll_capture(
                    &location,
                    model.as_deref(),
                    &services,
                    &mode,
                    error.as_deref(),
                    delay,
                );
            }
            thread::sleep(Duration::from_millis(100));
        }
    });
}

fn poll_capture(
    location: &CaptureLocation,
    model: Option<&str>,
    services: &serde_json::Value,
    mode: &str,
    error: Option<&str>,
    delay: Duration,
) -> io::Result<()> {
    let url = capture_url(location)?;
    let (status, body) = http_request(&url, "GET", "application/json", &[])?;
    if status != 200 || mode == "timeout" {
        return Ok(());
    }
    let request: serde_json::Value = serde_json::from_slice(&body).map_err(io::Error::other)?;
    let request_id = request["requestId"]
        .as_str()
        .ok_or_else(|| io::Error::other("capture request id is missing"))?;
    thread::sleep(delay);
    let (content_type, body) = if let Some(error) = error {
        let rejection =
            serde_json::from_str(error).unwrap_or_else(|_| serde_json::json!({ "error": error }));
        (
            "application/json",
            serde_json::to_vec(&rejection).map_err(io::Error::other)?,
        )
    } else {
        let metadata = serde_json::to_vec(&serde_json::json!({ "services": services }))
            .map_err(io::Error::other)?;
        let length = u32::try_from(metadata.len()).map_err(io::Error::other)?;
        let mut frame = length.to_le_bytes().to_vec();
        frame.extend_from_slice(&metadata);
        frame.extend_from_slice(&fs::read(
            model.ok_or_else(|| io::Error::other("capture model is missing"))?,
        )?);
        ("application/octet-stream", frame)
    };
    http_request(
        &format!("{url}&requestId={request_id}"),
        "POST",
        content_type,
        &body,
    )?;
    Ok(())
}

fn capture_url(location: &CaptureLocation) -> io::Result<String> {
    let port = match location {
        CaptureLocation::Rojo(port) => port,
        CaptureLocation::Snapshot(url) => return Ok(url.clone()),
    };
    let (status, body) = http_request(
        &format!("http://127.0.0.1:{port}/forge-capture"),
        "GET",
        "application/json",
        &[],
    )?;
    if status != 200 {
        return Err(io::Error::other("capture URL is not ready"));
    }
    let endpoint: serde_json::Value = serde_json::from_slice(&body).map_err(io::Error::other)?;
    let url = endpoint["url"]
        .as_str()
        .ok_or_else(|| io::Error::other("capture URL is not ready"))?;
    Ok(url.to_owned())
}

fn http_request(
    url: &str,
    method: &str,
    content_type: &str,
    body: &[u8],
) -> io::Result<(u16, Vec<u8>)> {
    let (port, target) = url
        .strip_prefix("http://127.0.0.1:")
        .and_then(|address| address.split_once('/'))
        .ok_or_else(|| io::Error::other("capture URL must be loopback HTTP"))?;
    let address: SocketAddr = format!("127.0.0.1:{port}")
        .parse()
        .map_err(io::Error::other)?;
    let mut socket = TcpStream::connect_timeout(&address, Duration::from_secs(2))?;
    socket.set_write_timeout(Some(Duration::from_secs(2)))?;
    socket.set_read_timeout(Some(Duration::from_secs(25)))?;
    write!(
        socket,
        "{method} /{target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\r\n",
        body.len()
    )?;
    socket.write_all(body)?;
    let mut response = Vec::new();
    socket.read_to_end(&mut response)?;
    let separator = response
        .windows(4)
        .position(|bytes| bytes == b"\r\n\r\n")
        .ok_or_else(|| io::Error::other("HTTP response has no headers"))?;
    let headers = std::str::from_utf8(&response[..separator]).map_err(io::Error::other)?;
    let status = headers
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| io::Error::other("HTTP response has no status"))?;
    Ok((status, response[separator + 4..].to_vec()))
}

fn acknowledge(url: &str) -> io::Result<()> {
    let (port, target) = url
        .strip_prefix("http://127.0.0.1:")
        .and_then(|address| address.split_once('/'))
        .ok_or_else(|| io::Error::other("ReadyUrl must be loopback HTTP"))?;
    let address: SocketAddr = format!("127.0.0.1:{port}")
        .parse()
        .map_err(io::Error::other)?;
    let timeout = Duration::from_secs(2);
    let mut socket = TcpStream::connect_timeout(&address, timeout)?;
    socket.set_write_timeout(Some(timeout))?;
    socket.set_read_timeout(Some(timeout))?;
    write!(
        socket,
        "GET /{target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )?;
    let mut response = [0; 1];
    socket.read_exact(&mut response)?;
    Ok(())
}

fn write_autosave(place: &Path) -> io::Result<()> {
    #[cfg(windows)]
    let root = PathBuf::from(env::var("LOCALAPPDATA").unwrap_or_default());
    #[cfg(unix)]
    let root = PathBuf::from(env::var("HOME").unwrap_or_default())
        .join("Library")
        .join("Application Support");
    let folder = root.join("Roblox").join("RobloxStudio").join("AutoSaves");
    fs::create_dir_all(&folder)?;
    let stem = place.file_stem().unwrap_or_default().to_string_lossy();
    fs::write(
        folder.join(format!("{stem}_AutoRecovery_0.rbxl")),
        "auto-recovery\n",
    )
}

fn record_start(args: &[String]) -> io::Result<()> {
    let Ok(log) = env::var("FIXTURE_LOG") else {
        return Ok(());
    };
    let mut markers = serde_json::Map::new();
    for (key, variable) in [
        ("session", "RBX_FORGE_SESSION"),
        ("worker", "RBX_FORGE_WORKER"),
    ] {
        if let Ok(value) = env::var(variable) {
            markers.insert(key.to_owned(), value.into());
        }
    }
    let mut record = serde_json::json!({
        "event": "start", "role": "studio", "args": args,
        "pid": std::process::id(), "ppid": parent_pid()?,
        "at": SystemTime::now().duration_since(UNIX_EPOCH).expect("after epoch").as_millis(),
        "markers": markers,
    });
    if let Ok(mode) = env::var("FIXTURE_MODE") {
        record["mode"] = mode.into();
    }
    let mut file = OpenOptions::new().create(true).append(true).open(log)?;
    writeln!(file, "{record}")
}

#[cfg(windows)]
fn parent_pid() -> io::Result<u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    // SAFETY: a snapshot of all processes, owned until CloseHandle below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: zero initialization is valid; dwSize tells the API the buffer size.
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = u32::try_from(std::mem::size_of::<PROCESSENTRY32W>()).expect("fits u32");
    let mut parent = 0;
    // SAFETY: snapshot is live and entry is writable with the matching size.
    let mut available = unsafe { Process32FirstW(snapshot, &raw mut entry) };
    while available != 0 {
        if entry.th32ProcessID == std::process::id() {
            parent = entry.th32ParentProcessID;
            break;
        }
        // SAFETY: snapshot is live and entry is writable with the matching size.
        available = unsafe { Process32NextW(snapshot, &raw mut entry) };
    }
    // SAFETY: this function owns the snapshot.
    unsafe { CloseHandle(snapshot) };
    Ok(parent)
}

#[cfg(unix)]
fn parent_pid() -> io::Result<u32> {
    // SAFETY: getppid takes no arguments and cannot fail.
    Ok(u32::try_from(unsafe { libc::getppid() }).expect("positive PID"))
}

#[cfg(windows)]
fn open_main_window(place: &str) -> io::Result<isize> {
    os::win::testing::open_test_window(&format!("{place} - Roblox Studio"), false)
}

#[cfg(unix)]
fn open_main_window(_: &str) -> io::Result<isize> {
    Ok(0)
}

#[cfg(windows)]
fn install_close_handler() {}

#[cfg(windows)]
fn close_requests() -> u32 {
    os::win::testing::close_requests()
}

#[cfg(unix)]
static CLOSE_REQUESTS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

#[cfg(unix)]
extern "C" fn on_close(_: libc::c_int) {
    CLOSE_REQUESTS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}

#[cfg(unix)]
fn install_close_handler() {
    // SAFETY: the signal handler only updates an atomic flag.
    unsafe { libc::signal(libc::SIGTERM, on_close as *const () as libc::sighandler_t) };
}

#[cfg(unix)]
fn close_requests() -> u32 {
    CLOSE_REQUESTS.load(std::sync::atomic::Ordering::SeqCst)
}

#[cfg(windows)]
fn disable_window(window: isize) {
    os::win::testing::set_window_enabled(window, false);
}

#[cfg(unix)]
fn disable_window(_: isize) {}

#[cfg(windows)]
fn open_dialog(owner: isize) -> io::Result<()> {
    os::win::testing::open_test_dialog(
        owner,
        &env::var("FIXTURE_STUDIO_DIALOG_TITLE")
            .unwrap_or_else(|_| "Lighting Technology Migration".to_owned()),
        &env::var("FIXTURE_STUDIO_DIALOG_BUTTON").unwrap_or_else(|_| "Continue".to_owned()),
    )?;
    Ok(())
}
#[cfg(not(windows))]
fn open_dialog(_owner: isize) -> io::Result<()> {
    Ok(())
}
