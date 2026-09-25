//! `forge-reaper`: owns every worker process of one session. Empty until the
//! reaper spike; it exists so CI builds the binary for every target.

fn main() {
    println!("forge-reaper {}", env!("CARGO_PKG_VERSION"));
}
