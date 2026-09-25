//! Read a string from the current user's registry hive, such as the command
//! Windows runs to open a `roblox-studio:` link.

use std::io;
use std::ptr::null_mut;

use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_SUCCESS};
use windows_sys::Win32::System::Registry::{
    HKEY_CURRENT_USER, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ, RegGetValueW,
};

use super::wide;

/// How often a read retries when the value grew between the size query and
/// the read.
const ATTEMPTS: usize = 3;

/// The default value of `HKEY_CURRENT_USER\<key>`, expanded when it is a
/// `REG_EXPAND_SZ`.
///
/// Returns `Ok(None)` when the key or its default value is missing.
///
/// # Errors
///
/// When the value is not a string, or the read fails for another reason.
pub fn read_user_default(key: &str) -> io::Result<Option<String>> {
    let key = wide(key);
    let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ;
    for _ in 0..ATTEMPTS {
        let mut bytes = 0_u32;
        // SAFETY: a size query: no data pointer, a local size.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                std::ptr::null(),
                flags,
                null_mut(),
                null_mut(),
                &raw mut bytes,
            )
        };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if status != ERROR_SUCCESS {
            return Err(os_error(status));
        }

        let mut buffer = vec![0_u16; (bytes as usize).div_ceil(2)];
        // SAFETY: the buffer holds `bytes` bytes.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                std::ptr::null(),
                flags,
                null_mut(),
                buffer.as_mut_ptr().cast(),
                &raw mut bytes,
            )
        };
        match status {
            ERROR_SUCCESS => {
                let text = String::from_utf16_lossy(&buffer[..(bytes as usize) / 2]);
                return Ok(Some(text.trim_end_matches('\0').to_owned()));
            }
            ERROR_FILE_NOT_FOUND => return Ok(None),
            ERROR_MORE_DATA => {}
            other => return Err(os_error(other)),
        }
    }

    Err(io::Error::other("the registry value kept growing"))
}

fn os_error(status: u32) -> io::Error {
    io::Error::from_raw_os_error(i32::try_from(status).unwrap_or(i32::MAX))
}

#[cfg(test)]
mod tests {
    use super::read_user_default;

    #[test]
    fn a_missing_key_reads_as_none() {
        let value = read_user_default(r"Software\rbx-forge-test\no such key").unwrap();
        assert_eq!(value, None);
    }

    #[test]
    fn a_present_default_value_reads_as_its_string() {
        // Every Windows user has this key; its default value is a string
        // (empty on most machines), or missing.
        let value = read_user_default(r"Environment");
        assert!(value.is_ok());
    }
}
