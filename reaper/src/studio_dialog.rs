//! Exact dialog actions on the pinned Studio's own desktop.
use std::io;
use std::time::Instant;

#[cfg(not(windows))]
pub fn dismiss(
    _pid: u32,
    _title: &str,
    _button: &str,
    _desktop: &str,
    _deadline: Instant,
) -> io::Result<bool> {
    Ok(false)
}

#[cfg(windows)]
pub fn dismiss(
    pid: u32,
    title: &str,
    button: &str,
    requested_desktop: &str,
    deadline: Instant,
) -> io::Result<bool> {
    use crate::os::win::{desktop, window};
    if Instant::now() >= deadline {
        return Ok(false);
    }
    let desktop = desktop::for_process(pid)?;
    let actual = if desktop.name()? == desktop::HIDDEN_NAME {
        "hidden"
    } else {
        "user"
    };
    if requested_desktop != actual {
        return Ok(false);
    }
    let Some(dialog) = window::titled_window(pid, title)? else {
        return Ok(false);
    };
    let dialog = dialog as isize;
    // CloseDesktop must run after the attached thread has exited.
    std::thread::scope(|scope| {
        scope
            .spawn(|| {
                desktop.attach()?;
                match unsafe { invoke(dialog, button, deadline) } {
                    // Another startup/save attempt can dismiss the same prompt first.
                    Err(err) if matches!(err.code().0 as u32, 0 | 0x80004003 | 0x80040201) => {
                        Ok(false)
                    }
                    result => result.map_err(|err| io::Error::other(err.to_string())),
                }
            })
            .join()
            .map_err(|_| io::Error::other("Studio dialog thread panicked"))?
    })
}

#[cfg(windows)]
unsafe fn invoke(handle: isize, button: &str, deadline: Instant) -> windows::core::Result<bool> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
        CoUninitialize,
    };
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Accessibility::{
        CUIAutomation8, IUIAutomation2, IUIAutomationInvokePattern, TreeScope_Descendants,
        UIA_ButtonControlTypeId, UIA_ControlTypePropertyId, UIA_InvokePatternId,
        UIA_NamePropertyId,
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
        if !bound(&automation, deadline)? {
            return Ok(false);
        }
        let dialog = automation.ElementFromHandle(HWND(handle as *mut _))?;
        let name = automation
            .CreatePropertyCondition(UIA_NamePropertyId, &VARIANT::from(BSTR::from(button)))?;
        let kind = automation.CreatePropertyCondition(
            UIA_ControlTypePropertyId,
            &VARIANT::from(UIA_ButtonControlTypeId.0),
        )?;
        let condition = automation.CreateAndCondition(&name, &kind)?;
        if !bound(&automation, deadline)? {
            return Ok(false);
        }
        let button = match dialog.FindFirst(TreeScope_Descendants, &condition) {
            Ok(button) => button,
            Err(err) if matches!(err.code().0 as u32, 0 | 0x80004003) => return Ok(false),
            Err(err) => return Err(err),
        };
        if !bound(&automation, deadline)? {
            return Ok(false);
        }
        let invoke: IUIAutomationInvokePattern = button.GetCurrentPatternAs(UIA_InvokePatternId)?;
        if !bound(&automation, deadline)? {
            return Ok(false);
        }
        invoke.Invoke()?;
        Ok(Instant::now() < deadline)
    }
}

#[cfg(windows)]
unsafe fn bound(
    automation: &windows::Win32::UI::Accessibility::IUIAutomation2,
    deadline: Instant,
) -> windows::core::Result<bool> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Ok(false);
    }
    let ms = u32::try_from(remaining.as_millis())
        .unwrap_or(u32::MAX)
        .max(1)
        .min(1000);
    unsafe {
        automation.SetConnectionTimeout(ms)?;
        automation.SetTransactionTimeout(ms)?;
    }
    Ok(true)
}
