//! Studio's English File > Save to File accessibility action.

use std::io;
use std::time::Instant;

#[cfg(not(any(windows, target_os = "macos")))]
pub fn request(_pid: u32, _deadline: Instant) -> io::Result<String> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Studio save is unsupported on this platform",
    ))
}

#[cfg(target_os = "macos")]
pub fn request(pid: u32, deadline: Instant) -> io::Result<String> {
    crate::os::macos_accessibility::request(pid, deadline)
}

/// Whether File > Save to File is enabled. Only macOS disables it.
#[cfg(target_os = "macos")]
pub fn enabled(pid: u32, deadline: Instant) -> io::Result<bool> {
    crate::os::macos_accessibility::save_enabled(pid, deadline)
}

#[cfg(not(target_os = "macos"))]
#[allow(clippy::unnecessary_wraps, reason = "shared Studio save surface")]
pub fn enabled(_pid: u32, _deadline: Instant) -> io::Result<bool> {
    Ok(true)
}

#[cfg(windows)]
pub fn request(pid: u32, deadline: Instant) -> io::Result<String> {
    use crate::os::win::{desktop, window};
    let desktop = desktop::for_process(pid)?;
    let Some(window) = window::studio_main_window(pid)? else {
        return Ok("no_menu_item".to_owned());
    };
    let window = window as isize;
    // Keep the handle in the parent until the attached COM thread exits.
    std::thread::scope(|scope| {
        scope
            .spawn(|| {
                desktop.attach()?;
                unsafe { windows_save(pid, window, deadline) }
                    .map_err(|err| io::Error::other(err.to_string()))
            })
            .join()
            .map_err(|_| io::Error::other("Studio save thread panicked"))?
    })
}

#[cfg(windows)]
unsafe fn windows_save(
    pid: u32,
    handle: isize,
    deadline: Instant,
) -> windows::core::Result<String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
        CoUninitialize,
    };
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Accessibility::{
        CUIAutomation8, IUIAutomation2, IUIAutomationExpandCollapsePattern,
        IUIAutomationInvokePattern, TreeScope_Children, TreeScope_Descendants,
        UIA_ControlTypePropertyId, UIA_ExpandCollapsePatternId, UIA_InvokePatternId,
        UIA_MenuItemControlTypeId, UIA_NamePropertyId,
    };
    use windows::core::BSTR;

    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
    }
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }
    let _apartment = Apartment;
    unsafe {
        let automation: IUIAutomation2 =
            CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)?;
        windows_deadline(&automation, deadline)?;
        let window = automation.ElementFromHandle(HWND(handle as *mut _))?;
        let menu_condition = automation.CreatePropertyCondition(
            UIA_ControlTypePropertyId,
            &VARIANT::from(UIA_MenuItemControlTypeId.0),
        )?;
        let name_condition = automation
            .CreatePropertyCondition(UIA_NamePropertyId, &VARIANT::from(BSTR::from("File")))?;
        let condition = automation.CreateAndCondition(&menu_condition, &name_condition)?;
        windows_deadline(&automation, deadline)?;
        let file = match window.FindFirst(TreeScope_Descendants, &condition) {
            Ok(item) => item,
            Err(err) if matches!(err.code().0 as u32, 0 | 0x80004003) => {
                return Ok("no_menu_item".to_owned());
            }
            Err(err) => return Err(err),
        };
        windows_deadline(&automation, deadline)?;
        let expand: IUIAutomationExpandCollapsePattern =
            file.GetCurrentPatternAs(UIA_ExpandCollapsePatternId)?;
        let condition = automation.CreatePropertyCondition(
            UIA_NamePropertyId,
            &VARIANT::from(BSTR::from("Save to File")),
        )?;
        let menu_deadline = deadline.min(Instant::now() + std::time::Duration::from_secs(15));
        let walker = automation.ControlViewWalker()?;
        let result = (|| loop {
            windows_action(&automation, deadline, pid, handle)?;
            // Startup can dismiss the popup before its accessible children appear.
            expand.Expand()?;
            windows_deadline(&automation, deadline)?;
            let item = walker.GetFirstChildElement(&file).and_then(|menu| {
                windows_deadline(&automation, deadline)?;
                menu.FindFirst(TreeScope_Children, &condition)
            });
            match item {
                Ok(item) => {
                    windows_deadline(&automation, deadline)?;
                    let invoke: IUIAutomationInvokePattern =
                        item.GetCurrentPatternAs(UIA_InvokePatternId)?;
                    windows_action(&automation, deadline, pid, handle)?;
                    invoke.Invoke()?;
                    break Ok("requested".to_owned());
                }
                Err(err) if matches!(err.code().0 as u32, 0 | 0x80004003) => {
                    if Instant::now() >= menu_deadline {
                        break Ok("no_menu_item".to_owned());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(err) => break Err(err),
            }
        })();
        if windows_action(&automation, deadline, pid, handle).is_ok() {
            let _ = expand.Collapse();
        }
        result
    }
}

#[cfg(windows)]
unsafe fn windows_deadline(
    automation: &windows::Win32::UI::Accessibility::IUIAutomation2,
    deadline: Instant,
) -> windows::core::Result<()> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
            0x80004004_u32 as i32,
        )));
    }
    let milliseconds = u32::try_from(remaining.as_millis())
        .unwrap_or(u32::MAX)
        .max(1);
    // SAFETY: automation is live in this thread's COM apartment.
    unsafe {
        automation.SetConnectionTimeout(milliseconds)?;
        automation.SetTransactionTimeout(milliseconds)
    }
}

#[cfg(windows)]
unsafe fn windows_action(
    automation: &windows::Win32::UI::Accessibility::IUIAutomation2,
    deadline: Instant,
    pid: u32,
    handle: isize,
) -> windows::core::Result<()> {
    unsafe { windows_deadline(automation, deadline)? };
    let mut actual = 0;
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(
            handle as *mut _,
            &raw mut actual,
        );
    }
    if actual != pid {
        return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
            0x80040201_u32 as i32,
        )));
    }
    Ok(())
}
