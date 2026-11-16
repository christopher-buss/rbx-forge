//! Plain Windows Studio entry points shared by the addon and stdio helper.
use std::io;

pub use crate::os::win::detach::Detached;

pub fn launch(spawn: &Detached<'_>) -> io::Result<Option<u32>> {
    crate::os::win::detach::spawn_detached(spawn)
}

pub fn launch_pinned(
    spawn: &Detached<'_>,
) -> io::Result<Option<crate::os::process::PinnedProcess>> {
    crate::os::win::detach::spawn_pinned(spawn)
}

pub fn host_identity() -> io::Result<(String, &'static str)> {
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, IsWow64Process2};
    use windows_sys::Win32::System::WindowsProgramming::GetComputerNameW;
    let mut name = [0u16; 256];
    let mut length = u32::try_from(name.len()).expect("fits");
    let mut process_machine = 0;
    let mut native_machine = 0;
    // SAFETY: writable buffers and the current process pseudo-handle are valid.
    unsafe {
        if GetComputerNameW(name.as_mut_ptr(), &mut length) == 0
            || IsWow64Process2(
                GetCurrentProcess(),
                &mut process_machine,
                &mut native_machine,
            ) == 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    let arch = match native_machine {
        0x8664 => "x64",
        0xaa64 => "arm64",
        0x014c => "ia32",
        _ => return Err(io::Error::other("unsupported Windows architecture")),
    };
    Ok((String::from_utf16_lossy(&name[..length as usize]), arch))
}
