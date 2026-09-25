//! `forge-reaper`: owns every worker process of one session. Empty until the
//! reaper core (#38); it exists so CI builds the binary for every target.
//!
//! It compiles the same `os` module tree as the addon, without napi, so the
//! `os` tests run through this target (`cargo test`).

#[allow(dead_code, reason = "the reaper core (#38) calls the os primitives")]
mod os;

fn main() {
    println!("forge-reaper {}", env!("CARGO_PKG_VERSION"));
}
