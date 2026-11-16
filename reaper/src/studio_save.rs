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
pub fn save_menu_enabled(pid: u32, deadline: Instant) -> io::Result<bool> {
    crate::os::macos_accessibility::save_enabled(pid, deadline)
}

#[cfg(not(target_os = "macos"))]
#[allow(clippy::unnecessary_wraps, reason = "shared Studio save surface")]
pub fn save_menu_enabled(_pid: u32, _deadline: Instant) -> io::Result<bool> {
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
        let walker = automation.ControlViewWalker()?;
        windows_action(&automation, deadline, pid, handle)?;
        crate::os::win::menu::activate(pid, handle as *mut _, deadline);
        let result = (|| {
            let item = find_menu_item(
                deadline,
                || {
                    windows_action(&automation, deadline, pid, handle)?;
                    expand.Expand()?;
                    windows_deadline(&automation, deadline)?;
                    match walker.GetFirstChildElement(&file).and_then(|menu| {
                        windows_deadline(&automation, deadline)?;
                        menu.FindFirst(TreeScope_Children, &condition)
                    }) {
                        Ok(item) => Ok(Some(item)),
                        Err(err) if matches!(err.code().0 as u32, 0 | 0x80004003) => Ok(None),
                        Err(err) => Err(err),
                    }
                },
                // Selecting another menu clears Qt's dismissed File selection.
                || reset_file_popup(&automation, &window, pid, handle, deadline),
                Instant::now,
                std::thread::sleep,
            )?;
            let Some(item) = item else {
                return Ok("no_menu_item".to_owned());
            };
            windows_deadline(&automation, deadline)?;
            let invoke: IUIAutomationInvokePattern =
                item.GetCurrentPatternAs(UIA_InvokePatternId)?;
            windows_action(&automation, deadline, pid, handle)?;
            invoke.Invoke()?;
            Ok("requested".to_owned())
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

#[cfg(windows)]
unsafe fn reset_file_popup(
    automation: &windows::Win32::UI::Accessibility::IUIAutomation2,
    window: &windows::Win32::UI::Accessibility::IUIAutomationElement,
    pid: u32,
    handle: isize,
    deadline: Instant,
) -> windows::core::Result<()> {
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Accessibility::{
        IUIAutomationExpandCollapsePattern, TreeScope_Descendants, UIA_ControlTypePropertyId,
        UIA_ExpandCollapsePatternId, UIA_MenuItemControlTypeId, UIA_NamePropertyId,
    };
    use windows::core::BSTR;
    unsafe {
        windows_action(automation, deadline, pid, handle)?;
        let name = automation
            .CreatePropertyCondition(UIA_NamePropertyId, &VARIANT::from(BSTR::from("Edit")))?;
        let kind = automation.CreatePropertyCondition(
            UIA_ControlTypePropertyId,
            &VARIANT::from(UIA_MenuItemControlTypeId.0),
        )?;
        let condition = automation.CreateAndCondition(&name, &kind)?;
        windows_deadline(automation, deadline)?;
        let edit = match window.FindFirst(TreeScope_Descendants, &condition) {
            Ok(edit) => edit,
            Err(err) if matches!(err.code().0 as u32, 0 | 0x80004003) => return Ok(()),
            Err(err) => return Err(err),
        };
        windows_deadline(automation, deadline)?;
        let expand: IUIAutomationExpandCollapsePattern =
            edit.GetCurrentPatternAs(UIA_ExpandCollapsePatternId)?;
        windows_action(automation, deadline, pid, handle)?;
        expand.Expand()?;
        windows_action(automation, deadline, pid, handle)?;
        expand.Collapse()
    }
}

#[cfg(windows)]
fn find_menu_item<T, E>(
    deadline: Instant,
    mut find: impl FnMut() -> Result<Option<T>, E>,
    reset: impl FnOnce() -> Result<(), E>,
    now: impl Fn() -> Instant,
    sleep: impl Fn(std::time::Duration),
) -> Result<Option<T>, E> {
    let mut reset = Some(reset);
    while now() < deadline {
        let item = find()?;
        if now() >= deadline {
            return Ok(None);
        }
        if item.is_some() {
            return Ok(item);
        }
        if let Some(reset) = reset.take() {
            reset()?;
        }
        sleep(
            deadline
                .saturating_duration_since(now())
                .min(std::time::Duration::from_millis(10)),
        );
    }
    Ok(None)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::time::Duration;

    #[test]
    fn recovers_a_dismissed_file_popup_before_returning_the_save_item() {
        let start = Instant::now();
        let clock = Cell::new(start);
        let reset = Cell::new(false);
        let found = find_menu_item(
            start + Duration::from_secs(1),
            || Ok::<_, ()>(reset.get().then_some("Save to File")),
            || {
                reset.set(true);
                Ok(())
            },
            || clock.get(),
            |duration| clock.set(clock.get() + duration),
        )
        .unwrap();
        assert_eq!(found, Some("Save to File"));
        assert!(reset.get());
    }

    #[test]
    fn retries_discovery_with_only_one_reset_and_the_original_deadline() {
        let start = Instant::now();
        let clock = Cell::new(start);
        let resets = Cell::new(0);
        let found = find_menu_item(
            start + Duration::from_millis(1003),
            || Ok::<Option<()>, ()>(None),
            || {
                resets.set(resets.get() + 1);
                Ok(())
            },
            || clock.get(),
            |duration| clock.set(clock.get() + duration),
        )
        .unwrap();
        assert_eq!(found, None);
        assert_eq!(resets.get(), 1);
        assert_eq!(clock.get(), start + Duration::from_millis(1003));
    }

    #[test]
    fn a_ready_item_does_not_reset_the_menu() {
        let start = Instant::now();
        let found = find_menu_item(
            start + Duration::from_secs(1),
            || Ok::<_, ()>(Some("Save to File")),
            || panic!("a ready popup does not need a reset"),
            || start,
            |_| panic!("a ready popup does not need another lookup"),
        )
        .unwrap();
        assert_eq!(found, Some("Save to File"));
    }

    #[test]
    fn a_lookup_that_consumes_the_deadline_cannot_return_an_invokable_item() {
        let start = Instant::now();
        let clock = Cell::new(start);
        let found = find_menu_item(
            start + Duration::from_secs(1),
            || {
                clock.set(start + Duration::from_secs(1));
                Ok::<_, ()>(Some("Save to File"))
            },
            || panic!("the deadline expired"),
            || clock.get(),
            |_| panic!("the deadline expired"),
        )
        .unwrap();
        assert_eq!(found, None);
    }
}
