//! OS primitives for process ownership. No napi here: the addon (`lib.rs`)
//! wraps them for Node, and the reaper binary (`main.rs`) compiles the same
//! module tree and calls them directly.
//!
//! - [`lock`]: exclusive and shared file locks that the OS releases when the
//!   holder dies.
//! - [`process`]: OS process start times and pinned process handles, so a
//!   kill never reaches a process that reused a PID.
//! - [`session`]: which processes belong to a session, for the barrier and
//!   forced cleanup.
//! - [`worker`]: one job or process group per worker (reaper binary only).

pub mod lock;
pub mod process;
pub mod session;
pub mod worker;
