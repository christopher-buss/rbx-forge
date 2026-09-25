//! Owner-only security: the current user's SID, a security descriptor that
//! grants that user alone full access (`O:<sid>D:P(A;;GA;;;<sid>)`), files
//! created with it, and a read-back of any object's owner and DACL.

use std::ffi::c_void;
use std::io;
use std::mem::{size_of, size_of_val};
use std::os::windows::io::OwnedHandle;
use std::ptr::null_mut;

use windows_sys::Win32::Foundation::{HANDLE, HLOCAL, INVALID_HANDLE_VALUE, LocalFree};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
    GetNamedSecurityInfoW, GetSecurityInfo, SDDL_REVISION_1, SE_FILE_OBJECT, SE_KERNEL_OBJECT,
    SE_OBJECT_TYPE,
};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION, AclSizeInformation,
    DACL_SECURITY_INFORMATION, GetAce, GetAclInformation, GetSecurityDescriptorControl,
    GetTokenInformation, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SE_DACL_PROTECTED,
    SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::Storage::FileSystem::{CREATE_NEW, CreateFileW, WriteFile};
use windows_sys::Win32::System::SystemServices::{ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows_sys::core::PWSTR;

use super::{check, owned, raw, wide};

/// `GENERIC_WRITE`: a new private file is opened to write it.
const GENERIC_WRITE: u32 = 0x4000_0000;

/// Memory the OS allocated with `LocalAlloc`, freed on drop.
struct Local(*mut c_void);

impl Drop for Local {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: the OS allocated it for the caller to free.
            unsafe { LocalFree(self.0 as HLOCAL) };
        }
    }
}

/// A SID as `S-1-5-...` text.
///
/// # Safety
///
/// `sid` must point to a valid SID.
unsafe fn sid_text(sid: PSID) -> io::Result<String> {
    let mut text: PWSTR = null_mut();
    // SAFETY: the caller passes a valid SID; the out pointer is a local.
    check(unsafe { ConvertSidToStringSidW(sid, &raw mut text) })?;
    let text = Local(text.cast());
    let pointer: *const u16 = text.0.cast();
    let mut length = 0;
    // SAFETY: the OS wrote a NUL-terminated string.
    while unsafe { *pointer.add(length) } != 0 {
        length += 1;
    }
    // SAFETY: `length` units were just read.
    let units = unsafe { std::slice::from_raw_parts(pointer, length) };
    Ok(String::from_utf16_lossy(units))
}

/// The SID of the user this process runs as, as `S-1-5-...` text.
///
/// # Errors
///
/// When the process token cannot be read.
pub fn current_user_sid() -> io::Result<String> {
    let mut token: HANDLE = null_mut();
    // SAFETY: the pseudo handle of this process; the out pointer is a local.
    check(unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw mut token) })?;
    let token = owned(token, null_mut())?;
    let mut length = 0;
    // SAFETY: a size query with no buffer; it fails by design.
    unsafe { GetTokenInformation(raw(&token), TokenUser, null_mut(), 0, &raw mut length) };
    let mut buffer = vec![0_usize; (length as usize).div_ceil(size_of::<usize>())];
    // SAFETY: the buffer holds `length` bytes, aligned for `TOKEN_USER`.
    check(unsafe {
        GetTokenInformation(
            raw(&token),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            length,
            &raw mut length,
        )
    })?;
    // SAFETY: the OS filled the buffer with a `TOKEN_USER`.
    let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    // SAFETY: the token's user SID is valid while the buffer lives.
    unsafe { sid_text(user.User.Sid) }
}

/// A security descriptor that grants the current user alone full access,
/// with inheritance off. Pipes and private files are created with it.
pub struct OwnerOnly {
    descriptor: Local,
}

// SAFETY: the descriptor is plain memory that nothing mutates after it is
// built; every thread only reads it.
unsafe impl Send for OwnerOnly {}
// SAFETY: as above.
unsafe impl Sync for OwnerOnly {}

impl std::fmt::Debug for OwnerOnly {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("OwnerOnly")
    }
}

impl OwnerOnly {
    /// # Errors
    ///
    /// When the user's SID cannot be read.
    pub fn new() -> io::Result<Self> {
        let sid = current_user_sid()?;
        let text = wide(&format!("O:{sid}D:P(A;;GA;;;{sid})"));
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        // SAFETY: valid SDDL text; the out pointer is a local.
        check(unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                text.as_ptr(),
                SDDL_REVISION_1,
                &raw mut descriptor,
                null_mut(),
            )
        })?;
        Ok(Self {
            descriptor: Local(descriptor),
        })
    }

    /// Attributes for a create call; valid while `self` lives.
    pub fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: u32::try_from(size_of::<SECURITY_ATTRIBUTES>()).expect("fits in u32"),
            lpSecurityDescriptor: self.descriptor.0,
            bInheritHandle: 0,
        }
    }
}

/// One access control entry.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Ace {
    /// `allow`, `deny`, or `other`.
    pub kind: &'static str,
    /// The access mask.
    pub mask: u32,
    /// The trustee as `S-1-5-...` text; empty for an `other` entry.
    pub sid: String,
}

/// The owner and DACL of an object.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Security {
    pub owner: String,
    /// Every entry, in order.
    pub aces: Vec<Ace>,
    /// Inheritance from the parent is off (`SE_DACL_PROTECTED`).
    pub protected: bool,
}

/// Read the owner and DACL out of a descriptor the OS returned.
///
/// # Safety
///
/// The pointers must come from one successful `Get*SecurityInfo` call.
unsafe fn read_security(
    owner: PSID,
    dacl: *mut ACL,
    descriptor: PSECURITY_DESCRIPTOR,
) -> io::Result<Security> {
    let mut control = 0_u16;
    let mut revision = 0_u32;
    // SAFETY: a valid descriptor; the out pointers are locals.
    check(unsafe {
        GetSecurityDescriptorControl(descriptor, &raw mut control, &raw mut revision)
    })?;
    let mut aces = Vec::new();
    if !dacl.is_null() {
        let mut size = ACL_SIZE_INFORMATION {
            AceCount: 0,
            AclBytesInUse: 0,
            AclBytesFree: 0,
        };
        // SAFETY: a valid ACL; the struct and size match the class.
        check(unsafe {
            GetAclInformation(
                dacl,
                (&raw mut size).cast(),
                u32::try_from(size_of_val(&size)).expect("fits in u32"),
                AclSizeInformation,
            )
        })?;
        for index in 0..size.AceCount {
            let mut ace: *mut c_void = null_mut();
            // SAFETY: the index is below the ACE count.
            check(unsafe { GetAce(dacl, index, &raw mut ace) })?;
            // SAFETY: every ACE starts with a header.
            let header = unsafe { &*ace.cast::<ACE_HEADER>() };
            let kind = match u32::from(header.AceType) {
                ACCESS_ALLOWED_ACE_TYPE => "allow",
                ACCESS_DENIED_ACE_TYPE => "deny",
                _ => "other",
            };
            if kind == "other" {
                aces.push(Ace {
                    kind,
                    mask: 0,
                    sid: String::new(),
                });
                continue;
            }
            // Allow and deny entries share this layout.
            // SAFETY: the type says the ACE has this layout.
            let entry = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
            // SAFETY: the SID starts at `SidStart` inside the ACE.
            let sid = unsafe { sid_text((&raw const entry.SidStart).cast_mut().cast())? };
            aces.push(Ace {
                kind,
                mask: entry.Mask,
                sid,
            });
        }
    }

    Ok(Security {
        // SAFETY: the owner SID lives inside the descriptor.
        owner: unsafe { sid_text(owner)? },
        aces,
        protected: control & SE_DACL_PROTECTED != 0,
    })
}

fn security_of(
    read: impl FnOnce(&mut PSID, &mut *mut ACL, &mut PSECURITY_DESCRIPTOR) -> u32,
) -> io::Result<Security> {
    let mut owner: PSID = null_mut();
    let mut dacl: *mut ACL = null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    let status = read(&mut owner, &mut dacl, &mut descriptor);
    if status != 0 {
        return Err(io::Error::from_raw_os_error(
            i32::try_from(status).unwrap_or(i32::MAX),
        ));
    }
    let descriptor = Local(descriptor);
    // SAFETY: the pointers come from the successful call above and live in
    // `descriptor`.
    unsafe { read_security(owner, dacl, descriptor.0) }
}

/// The owner and DACL of a kernel object, such as a pipe instance.
///
/// # Errors
///
/// When the handle lacks `READ_CONTROL`.
pub fn security_of_handle(handle: &OwnedHandle) -> io::Result<Security> {
    security_of_object(raw(handle), SE_KERNEL_OBJECT)
}

fn security_of_object(handle: HANDLE, kind: SE_OBJECT_TYPE) -> io::Result<Security> {
    security_of(|owner, dacl, descriptor| {
        // SAFETY: an open handle; the out pointers are the caller's locals.
        unsafe {
            GetSecurityInfo(
                handle,
                kind,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                owner,
                null_mut(),
                dacl,
                null_mut(),
                descriptor,
            )
        }
    })
}

/// The owner and DACL of a file.
///
/// # Errors
///
/// When the file does not exist or its security cannot be read.
pub fn security_of_file(path: &str) -> io::Result<Security> {
    let path = wide(path);
    security_of(|owner, dacl, descriptor| {
        // SAFETY: a NUL-terminated path; the out pointers are the caller's
        // locals.
        unsafe {
            GetNamedSecurityInfoW(
                path.as_ptr(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                owner,
                null_mut(),
                dacl,
                null_mut(),
                descriptor,
            )
        }
    })
}

/// Create a new file that only the current user can open, and write
/// `contents` to it. The file never exists with any other DACL.
///
/// # Errors
///
/// When the file already exists or cannot be written.
pub fn write_private_file(path: &str, contents: &[u8]) -> io::Result<()> {
    let security = OwnerOnly::new()?;
    let attributes = security.attributes();
    let name = wide(path);
    // SAFETY: a NUL-terminated path and attributes that outlive the call.
    let file = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_WRITE,
            0,
            &raw const attributes,
            CREATE_NEW,
            0,
            null_mut(),
        )
    };
    let file = owned(file, INVALID_HANDLE_VALUE)?;
    let mut written = 0_u32;
    let length = u32::try_from(contents.len()).map_err(io::Error::other)?;
    // SAFETY: an open file; the buffer holds `length` bytes.
    check(unsafe {
        WriteFile(
            raw(&file),
            contents.as_ptr(),
            length,
            &raw mut written,
            null_mut(),
        )
    })?;
    if written != length {
        return Err(io::Error::other("short write"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{current_user_sid, security_of_file, write_private_file};

    #[test]
    fn private_file_grants_the_current_user_alone() {
        let directory = std::env::temp_dir().join(format!("forge-private-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("temp directory");
        let file = directory.join("token");
        let path = file.to_str().expect("utf-8 path");
        write_private_file(path, b"secret").expect("write");

        let security = security_of_file(path).expect("read back");
        let user = current_user_sid().expect("sid");
        assert_eq!(std::fs::read_to_string(&file).expect("read"), "secret");
        assert!(
            write_private_file(path, b"again").is_err(),
            "never replaced"
        );
        std::fs::remove_dir_all(&directory).expect("clean up");
        assert_eq!(security.owner, user);
        assert!(security.protected);
        assert_eq!(security.aces.len(), 1);
        assert_eq!(security.aces[0].kind, "allow");
        assert_eq!(security.aces[0].sid, user);
    }
}
