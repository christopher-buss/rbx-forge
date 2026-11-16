//! Identity-checked accessibility operations shared by the addon and helper.
use crate::os::process::PinnedProcess;
use std::io;
use std::time::Instant;

pub fn save(pid: u32, start_time: u64, deadline: Instant) -> io::Result<String> {
    if Instant::now() >= deadline {
        return Ok("timeout".to_owned());
    }
    let pinned = PinnedProcess::open(pid)?.ok_or_else(|| io::Error::other("Studio exited"))?;
    if pinned.start_time() != start_time {
        return Err(io::Error::other("Studio identity changed"));
    }
    #[cfg(windows)]
    let result = crate::os::win::visibility::with_hiding_paused(&pinned, || {
        crate::studio_save::request(pid, deadline)
    });
    #[cfg(not(windows))]
    let result = crate::studio_save::request(pid, deadline);
    match result {
        _ if Instant::now() >= deadline => Ok("timeout".to_owned()),
        result => result,
    }
}

pub fn dismiss(
    pid: u32,
    start_time: u64,
    title: &str,
    button: &str,
    desktop: &str,
    deadline: Instant,
) -> io::Result<bool> {
    let Some(pinned) = PinnedProcess::open(pid)? else {
        return Ok(false);
    };
    if pinned.start_time() != start_time {
        return Ok(false);
    }
    match crate::studio_dialog::dismiss(pid, title, button, desktop, deadline) {
        _ if Instant::now() >= deadline => Ok(false),
        result => result,
    }
}

pub fn save_menu(pid: u32, deadline: Instant) -> io::Result<bool> {
    if Instant::now() >= deadline {
        return Ok(false);
    }
    crate::studio_save::save_menu_enabled(pid, deadline)
}
