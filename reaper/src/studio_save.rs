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

#[cfg(windows)]
pub fn request(pid: u32, deadline: Instant) -> io::Result<String> {
    // UI Automation requires its own COM apartment, away from Node's event loop.
    std::thread::spawn(move || unsafe { windows_save(pid, deadline) })
        .join()
        .map_err(|_| io::Error::other("Studio save thread panicked"))?
        .map_err(|err| io::Error::other(err.to_string()))
}

#[cfg(windows)]
unsafe fn windows_save(pid: u32, deadline: Instant) -> windows::core::Result<String> {
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
        CoUninitialize,
    };
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Accessibility::{
        CUIAutomation8, IUIAutomation2, IUIAutomationExpandCollapsePattern,
        IUIAutomationInvokePattern, TreeScope_Children, TreeScope_Descendants,
        UIA_ControlTypePropertyId, UIA_ExpandCollapsePatternId, UIA_InvokePatternId,
        UIA_MenuItemControlTypeId, UIA_NamePropertyId, UIA_ProcessIdPropertyId,
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
        let root = automation.GetRootElement()?;
        let pid_condition = automation
            .CreatePropertyCondition(UIA_ProcessIdPropertyId, &VARIANT::from(pid as i32))?;
        windows_deadline(&automation, deadline)?;
        let window = root.FindFirst(TreeScope_Children, &pid_condition)?;
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
            Err(err) if err.code().0 == 0x80004003_u32 as i32 => {
                return Ok("no_menu_item".to_owned());
            }
            Err(err) => return Err(err),
        };
        windows_deadline(&automation, deadline)?;
        let expand: IUIAutomationExpandCollapsePattern =
            file.GetCurrentPatternAs(UIA_ExpandCollapsePatternId)?;
        windows_deadline(&automation, deadline)?;
        expand.Expand()?;
        let condition = automation.CreatePropertyCondition(
            UIA_NamePropertyId,
            &VARIANT::from(BSTR::from("Save to File")),
        )?;
        let menu_deadline = deadline.min(Instant::now() + std::time::Duration::from_secs(5));
        let result = (|| loop {
            windows_deadline(&automation, deadline)?;
            match file.FindFirst(TreeScope_Descendants, &condition) {
                Ok(item) => {
                    windows_deadline(&automation, deadline)?;
                    let invoke: IUIAutomationInvokePattern =
                        item.GetCurrentPatternAs(UIA_InvokePatternId)?;
                    windows_deadline(&automation, deadline)?;
                    invoke.Invoke()?;
                    break Ok("requested".to_owned());
                }
                Err(err) if err.code().0 == 0x80004003_u32 as i32 => {
                    if Instant::now() >= menu_deadline {
                        break Ok("no_menu_item".to_owned());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(err) => break Err(err),
            }
        })();
        if windows_deadline(&automation, deadline).is_ok() {
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
