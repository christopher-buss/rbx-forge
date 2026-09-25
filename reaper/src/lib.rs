//! `@rbx-forge/native`: the Node addon half of the crate. Empty until the
//! reaper spike; it exists so CI builds the addon for every target.

use napi_derive::napi;

/// Version of the native crate, so the JS side can check it loaded the
/// matching build.
#[napi]
pub fn native_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}
