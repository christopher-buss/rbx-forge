# Rust standards for `reaper/`

How to hold the `forge-reaper` crate to the bar the TypeScript side already
meets (`AGENTS.md`): what each TypeScript rule maps to in Rust, what the crate
does today, and what to adopt. Measured on 2026-10-07 on macOS arm64 with Rust
1.98.1, clippy 0.1.98, cargo-llvm-cov 0.9.1, cargo-mutants 27.1.0, cargo-deny
0.20.2, cargo-machete 0.9.2 and typos 1.51.1. Windows and Linux numbers are not
measured.

## Recommendations

Must-have:

1. **A `[lints]` table and `clippy.toml`** (all deny, pedantic warn, a short
   restriction list, unwrap allowed only in tests). Cost on macOS: 36 warnings,
   2 errors. See [Lints](#lints).
2. **Clippy on all three OSes.** CI runs clippy only on Linux x86_64; about
   3,600 Windows-only and 870 macOS-only lines are never linted. See
   [Lints](#lints).
3. **cargo-nextest as the runner**, with per-test timeouts and flaky tests
   failing. The tests kill processes and share process-global state. See
   [Runner](#runner-cargo-nextest).
4. **A cargo-llvm-cov gate**: 100% on the pure modules now, and an overall floor
   that only moves up. See [Coverage](#coverage).
5. **cargo-mutants on the pure modules, zero survivors**, the Stryker
   `break: 100` equivalent. 6 of 74 mutants survive today. See
   [Mutation testing](#mutation-testing).

Nice-to-have:

1. **Split the crate**: a core `rlib` with the logic, and a thin `main.rs` and
   `lib.rs` over it. The cheaper first step is turning the addon's test target
   on (verified on macOS). See [Test layout](#test-layout).
2. **proptest for `protocol.rs` and `model.rs`.** See
   [Property tests](#property-tests).
3. **cargo-deny** for licenses, advisories and sources. It passes with a
   7-license allow list. See
   [Supply chain](#supply-chain-and-unused-dependencies).
4. **typos and cargo-machete** as the cspell and knip equivalents. Both report 0
   findings today.
5. **A stable-only `rustfmt.toml`** (0 diffs today), and opt-in nursery and
   `unreachable_pub` lints (22 and 110 warnings).

## Test layout

**Current state**

- `Cargo.toml` declares three targets: the `forge_native` lib, which is `cdylib`
  only and has `test = false` and `doctest = false`; the `forge-reaper` bin; and
  the `forge-studio-fixture` bin, which has `test = false` and pulls in `os/`
  through `#[path = "../os/mod.rs"]`.
- All Rust tests run through the `forge-reaper` bin, which compiles `os/`,
  `protocol.rs`, `reaper.rs` and, under `#[cfg(test)]`, `model.rs`
  (`src/main.rs:21-26`). `cargo test` never compiles `lib.rs`, `studio_save.rs`,
  `studio_dialog.rs` or `windows_exports.rs`.
- Both roots put `#[allow(dead_code)]` on all of `mod os` (`src/main.rs:23`,
  `src/lib.rs:12`). Today no `os` item is dead in both targets (checked by
  removing both allows on macOS), but the allow would hide any that become dead
  later.
- The tests sit in `#[cfg(test)] mod tests` blocks and in two files,
  `os/worker/tests.rs` and `os/session/tests.rs`. There is no `reaper/tests/`
  directory and there are no doctests.
- `reaper.rs` already has the seam pattern: the `Platform` and `Tree` traits,
  with hand-written `FakePlatform` and `FakeTree` in its test module.
- The TypeScript integration tests drive the built reaper and addon (for example
  `test/integration/reaper.spec.ts` and `native.spec.ts`).

**Convention**

- The Rust Book defines unit tests as `#[cfg(test)] mod tests` beside the code,
  with access to private items. Integration tests go in `tests/` and use only
  the public API. A binary-only crate "cannot create integration tests", so the
  Book recommends a thin `src/main.rs` over `src/lib.rs`
  ([Book ch. 11.3](https://doc.rust-lang.org/book/ch11-03-test-organization.html)).
- For each binary target, Cargo builds the binary for integration tests and sets
  `CARGO_BIN_EXE_<name>`, so a test in `tests/` can spawn it
  ([Cargo targets](https://doc.rust-lang.org/cargo/reference/cargo-targets.html)).
  Verified here: a `tests/smoke.rs` that runs
  `env!("CARGO_BIN_EXE_forge-reaper")` builds and passes, even with a
  `cdylib`-only lib.
- `test = false` turns off a target's unit tests. `doctest` applies only to
  libraries
  ([Cargo targets](https://doc.rust-lang.org/cargo/reference/cargo-targets.html)).
- The `Cargo.toml` comment says a test executable cannot link the napi symbols
  that Node provides. In `napi-build` 2.5.0 (local source), the
  `-undefined dynamic_lookup` flag applies only to the `cdylib` on macOS
  (`rustc-cdylib-link-arg`). Even so, setting `test = true` on the lib in a
  scratch copy builds and runs all 46 lib tests on macOS, because nothing in the
  tests calls into napi. Linux and Windows are not verified. napi's default
  `dyn-symbols` feature (off here, through `default-features = false`) resolves
  napi symbols at runtime instead of at link time (`napi-sys` source), which
  should make the link work on every OS.

**Recommendation**

- **Nice-to-have, step 1 (cheap):** set `test = true` on `[lib]`. That puts
  `studio_save.rs`, `studio_dialog.rs` and `lib.rs`'s own helpers under
  `cargo test`, and under coverage and mutation testing. Confirm Linux and
  Windows in CI. If the link fails there, turn on napi's `dyn-symbols`.
- **Nice-to-have, step 2 (the conventional fix):** a Cargo workspace with
  `forge-core` (an `rlib` holding `os/`, `model`, `protocol`, `reaper`,
  `studio_*`), `forge-native` (the `cdylib`, napi glue only) and `forge-reaper`
  (a thin `main` that only builds `OsPlatform` and calls `serve`). This removes
  the `#[path]` include and both blanket `dead_code` allows, and it lets
  `tests/` link the core. It also matches the TypeScript split, where only
  `cli.ts` and `supervisor.ts` touch the process.
- **`reaper/tests/`:** keep it small. The TypeScript integration tests already
  cover the protocol end to end. Add `tests/` only for Rust-side invariants of
  the built binary that the TypeScript tests cannot observe cheaply, such as
  exit codes for bad arguments, `--version`, and `serve` with a closed stdin.
  `main.rs` is 0% covered today, and the `CARGO_BIN_EXE_forge-reaper` route
  needs no restructuring.
- **Doctests:** skip them. This is not a published library, and the TypeScript
  side has no equivalent.

```toml
[lib]
name = "forge_native"
crate-type = [ "cdylib" ]
path = "src/lib.rs"
doctest = false
```

## Coverage

**Current state**

Measured with `cargo llvm-cov --summary-only` (the bin target only): 70.8%
lines, 69.4% regions, 73.0% functions. `main.rs` is 0%,
`os/macos_application.rs` 0%, `os/macos_accessibility.rs` 3.5% and
`os/worker/unix.rs` 64.0%. The pure modules are nearly done: `protocol.rs` 100%,
`os/worker/converge.rs` 100% lines (one region missed), `reaper.rs` 96.8% and
`model.rs` 97.8%. Six process tests failed in this sandboxed run (for example
`os::process::tests::has_environment_reads_the_environment_the_process_started_with`),
so these numbers are a lower bound. The report leaves out `tests.rs` files on
its own.

**Convention**

- cargo-llvm-cov has `--fail-under-lines`, `--fail-under-regions`,
  `--fail-under-functions` and `--fail-under-file-lines` (per file).
  `--ignore-filename-regex` drops files from the report. It skips `tests/`
  directories and `tests.rs`/`*_tests.rs` files by default
  ([cargo-llvm-cov](https://github.com/taiki-e/cargo-llvm-cov)).
- `#[coverage(off)]` is unstable. The README recommends
  `#[cfg_attr(coverage_nightly, coverage(off))]`; on stable it does nothing.
  Branch coverage (`--branch`) is also nightly-only
  ([cargo-llvm-cov](https://github.com/taiki-e/cargo-llvm-cov)).
- Runs merge with `--no-report` and then `cargo llvm-cov report`. For "external
  tests" (any binary built by cargo), run
  `source <(cargo llvm-cov show-env --sh)`, build, run, then `report`
  ([cargo-llvm-cov](https://github.com/taiki-e/cargo-llvm-cov)). An instrumented
  process writes its `.profraw` when it exits normally. A process killed by a
  signal loses its data unless `LLVM_PROFILE_FILE` contains `%c` (continuous
  mode, supported on Darwin and some other platforms)
  ([rustc instrument-coverage](https://doc.rust-lang.org/rustc/instrument-coverage.html)).

**Recommendation (must-have)**

The TypeScript gate is 100% on code that never spawns a process, with the two
process-touching modules excluded. The Rust equivalent:

- **Unit gate: 100% lines on the pure modules**, `reaper.rs`, `protocol.rs`,
  `model.rs` and `os/worker/converge.rs` (plus `lib.rs` helpers once the lib is
  tested). Like the TypeScript seams, these run only against fakes. Closing the
  gap costs about 19 lines.
- **Overall floor that only moves up**: start at the measured value per OS,
  rounded down (70% on macOS), and raise it in the same PR as the tests that
  earn it, the same way as Stryker's floor. `main.rs` plays the role of
  `supervisor.ts`: keep it thin and leave it to the integration tests.
- Merge coverage across OSes by uploading each OS's lcov and combining them in a
  final job, or by gating per OS. An OS-specific file only reaches 100% on its
  own OS, so gate per OS and do not merge for the threshold.

```sh
# Unit gate: pure modules only.
cargo llvm-cov nextest --manifest-path reaper/Cargo.toml \
  --ignore-filename-regex '(main\.rs|/os/(process|session|win|lock|macos_|worker/(unix|windows|mod)))' \
  --fail-under-lines 100
# Overall floor (per OS; raise, never lower).
cargo llvm-cov nextest --manifest-path reaper/Cargo.toml --fail-under-lines 70
```

**Nice-to-have:** count the TypeScript integration tests too. Build the reaper
and addon under `show-env` (debug, instrumented), run `pnpm test:integration`
against them, then `cargo llvm-cov report`. This should lift `main.rs` and
`os/worker/unix.rs`, which the integration tests drive through signals and
grandchildren (`os/worker/tests.rs:1-3` says so). Not verified: how napi's
release build path (`napi build --release`) and a reaper that ends on a signal
interact with profile writing.

## Mutation testing

**Current state**

The crate has no mutation testing. Stryker ignores `/reaper`
(`stryker.config.ts`), and its thresholds are `break: 100`.

Measured with
`cargo mutants -f src/protocol.rs -f src/reaper.rs -f src/model.rs -f src/os/worker/converge.rs`
and a test filter for those modules: 74 mutants in 3m25s. 47 caught, 11
timeouts, 10 unviable, **6 missed**: `model.rs:103` (`delete !` in
`write_sources`), `reaper.rs:214` (`==`→`!=` in `request`), `reaper.rs:251`
(`+=`→`*=` in `spawn`), `reaper.rs:288` (`<=`→`>` in `stop`), and
`reaper.rs:303` twice (arithmetic in `force`). The 11 timeouts are mutants that
hang the fake-driven loop until the auto-set 20 s timeout.

`cargo mutants --list` shows about 3,100 mutants for the whole crate. `os/` is
counted twice (through the roots and again through `src/bin/../os/` from the
`#[path]` include). cargo-mutants mutates `#[cfg(windows)]` code on macOS too.

**Convention**

- cargo-mutants exits 0 when every viable mutant is caught, 2 when a mutant
  survives, 3 on timeouts and 4 when the baseline fails. It writes
  `mutants.out/missed.txt`, `caught.txt` and `timeout.txt`
  ([cargo-mutants book](https://mutants.rs/)).
- `--in-diff <file>` tests only mutants in changed regions. The book warns that
  this is "not a substitute for a full test run" and that a diff touching only
  tests runs no mutants ([in-diff](https://mutants.rs/in-diff.html)).
- In CI, the book recommends `--in-place`, installing a binary through
  `taiki-e/install-action`, PR-diff runs plus full runs, and `--shard k/n`
  ([CI](https://mutants.rs/ci.html)).
- The config file is `.cargo/mutants.toml`, with keys such as `exclude_globs`,
  `examine_globs`, `exclude_re`, `test_tool = "nextest"`, `timeout_multiplier`
  and `additional_cargo_test_args`. Functions are skipped with
  `#[cfg_attr(test, mutants::skip)]` (the `mutants` crate as a dev-dependency)
  ([book](https://mutants.rs/print.html)).

**Recommendation (must-have)**

- Gate on **zero missed** (exit code 2 fails the job), like Stryker's
  `break: 100`. Start with the four pure modules, kill the 6 survivors, then
  widen `examine_globs` one module at a time. The examined set is the floor, and
  it only grows.
- Run `--in-diff` in the pre-push hook, the way hk runs `pnpm mutation`, and a
  full run of the examined set in CI.
- Use nextest so a hanging mutant only costs one test's timeout.
- Each `mutants::skip` carries a reason comment, like the 13 `Stryker disable`
  comments in `src/`.

```toml
# reaper/.cargo/mutants.toml
examine_globs = [
  "src/protocol.rs",
  "src/reaper.rs",
  "src/model.rs",
  "src/os/worker/converge.rs"
]
exclude_globs = [ "src/bin/**" ]
test_tool = "nextest"
timeout_multiplier = 3.0
```

```pkl
// hk.pkl, pre-push
["mutation-native"] {
    glob = List("reaper/src/**/*.rs")
    check = "git diff origin/main...HEAD -- reaper/src > reaper/target/pr.diff && cargo mutants --manifest-path reaper/Cargo.toml --in-diff reaper/target/pr.diff"
    profiles = List("agent")
}
```

Cost: the 6 missed mutants need new assertions in `reaper.rs` and `model.rs`.
The CI time is about 3 to 4 minutes for the pure modules with `cargo test`, and
should be less with nextest timeouts.

## Runner: cargo-nextest

**Current state**

`cargo test` runs every test as a thread in one process. The tests compensate
with per-test names (`std::process::id()` plus a name) in `worker/tests.rs` and
`session/tests.rs`. `os/worker/unix.rs:36-42` holds process-global state:
`LEADERS` and `OWNER`, documented as "in a test process, other children are the
tests'". A hang in a process-killing test blocks the whole binary until the CI
job timeout.

**Convention**

nextest runs each test in its own process. This gives isolation ("One test
segfaulting does not take down a bunch of other tests"), per-test timeouts and
termination, and retries with flaky detection
([why process-per-test](https://nexte.st/docs/design/why-process-per-test/)).
The `slow-timeout = { period, terminate-after, grace-period }` setting and
per-test `overrides` live in `.config/nextest.toml`
([slow tests](https://nexte.st/docs/features/slow-tests/)). With
`flaky-result = "fail"`, a test that passes only on retry fails the run
([retries](https://nexte.st/docs/features/retries/)). `leak-timeout` with
`result = "fail"` fails tests that leave subprocesses holding the test's stdout
or stderr. It cannot see children whose stdio is redirected
([leaky tests](https://nexte.st/docs/features/leaky-tests/)). cargo-llvm-cov
(`cargo llvm-cov nextest`) and cargo-mutants (`test_tool = "nextest"`) both run
on it.

**Recommendation (must-have)**

```toml
# reaper/.config/nextest.toml
[profile.default]
slow-timeout = { period = "15s", terminate-after = 4 }
leak-timeout = { period = "500ms", result = "fail" }
retries = 0
flaky-result = "fail"

[profile.ci]
fail-fast = false
```

`retries = 0` keeps the TypeScript stance that a flaky test is a bug. Process
isolation also makes it possible to unit-test `become_owner` (subreaper) and
`LEADERS` paths that a shared test process cannot exercise safely. That gap
probably explains part of `unix.rs`'s 64%. Not verified: nextest was not
installed or run here.

## Seams and fakes

**Current state**

`reaper.rs` follows the TypeScript seam rule: `Platform` and `Tree` are traits,
`Reaper<P, W>` takes them as generics, and the test module has hand-written
`FakePlatform` and `FakeTree` that log calls to a shared `Vec<String>`. No
mocking crate is used. The `os/` layer is the real implementation and is tested
against real processes.

**Convention**

The Rust equivalent of an injected `Seams` record is a trait (or a struct of
trait objects) passed in as a generic parameter or `&dyn Trait`. Rust has no
runtime module patching, so nothing like `vi.mock` exists. The nearest thing is
mockall, which generates expectation-based `Mock*` types from `#[automock]` on a
trait ([mockall 0.15.0](https://docs.rs/mockall/latest/mockall/)). That is the
mock style the TypeScript rule bans in spirit: expectations on calls rather than
a working fake.

**Recommendation (must-have, policy only)**

- Keep hand-written fakes. Ban `mockall` and similar crates through cargo-deny
  `bans.deny` (snippet in
  [Supply chain](#supply-chain-and-unused-dependencies)).
- Move logic out of `main.rs` behind `Platform` (it already has `OsPlatform`),
  so `serve` can run against `FakePlatform` and the 0% file shrinks to wiring.
- Add a new OS dependency as a trait method, and put its fake next to the
  existing ones. Move the fakes into a shared `#[cfg(test)] mod testing` when a
  second module needs them, mirroring `test/helpers/seams.ts`.

## Test style

**Current state**

- Rust has no `beforeEach` or `afterEach`, so "no lifecycle hooks" holds by
  construction. Cleanup is RAII: `session/tests.rs:106` implements `Drop` for
  `Owned`, which is the `onTestFinished` equivalent, and `model.rs:122` uses
  `tempfile::TempDir`.
- `worker/tests.rs:10-15` and `session/tests.rs:22-25` create directories under
  `std::env::temp_dir()` and never remove them.
- The `if`s are in helpers (`shell`, `wait_until`), not in test bodies. Platform
  splits use `#[cfg(unix)]` and `#[cfg(windows)]` on whole tests.

**Recommendation**

- **Must-have:** use `tempfile::tempdir()` (already a dependency) in the
  `directory`/`Session::new` factories, so the `TempDir` guard is the cleanup.
- **Must-have, review rule:** no `if` or `match` in a `#[test]` body. Use
  `assert!`, `assert_eq!`, `assert!(matches!(..))`, and `#[cfg]` on the test for
  platform branches. Clippy has no lint for this, so it stays a review rule.
- `unwrap()` in tests is fine and idiomatic. Allow it only there through
  `clippy.toml` (see [Lints](#lints)).

## Property tests

**Convention**

proptest generates inputs from composable per-value strategies, shrinks a
failure to a minimal case, and saves failing seeds under `proptest-regressions/`
([proptest book](https://proptest-rs.github.io/proptest/intro.html)).

**Recommendation (nice-to-have)**

The candidates are the round-trip and total-function properties:

- `protocol.rs`: for any `Event`, `encode_event` ends in exactly one `\n` and
  parses back. For any `Request`, `serde_json::to_string` then parse is the
  identity (`deny_unknown_fields` makes parsing strict).
- `model.rs` path resolution: the result is `Err` exactly when the path is
  empty, missing or ambiguous, and never panics on arbitrary names.

```toml
[dev-dependencies]
proptest = "1"
```

Commit `proptest-regressions/`, since it is the regression record. Cost: a new
dev-dependency, plus `Arbitrary`/strategy code for `SpawnRequest`.

## Lints

**Current state**

- No `[lints]` table, no `clippy.toml`, no `rustfmt.toml`, no
  `rust-toolchain.toml`. The toolchain is pinned in `mise.toml`
  (`rust = 1.98.1`, clippy and rustfmt components).
- `native.yaml` runs `cargo fmt --check` and `cargo clippy -- -D warnings` only
  on the `checks: true` row (`ubuntu-latest`, `x86_64-unknown-linux-gnu`),
  without `--all-targets`, so test code is not linted. About 3,600 lines under
  `#[cfg(windows)]` (`os/win/`, `windows_exports.rs`, `os/process/windows.rs`,
  `os/worker/windows.rs`, `studio_*` halves) and 870 macOS-only lines are never
  linted in CI.
- `cargo clippy --all-targets` is clean on macOS today.
- `#[allow(..., reason = ...)]` already appears on all 9 allows, and
  `// SAFETY:` comments (213) nearly match `unsafe {` blocks (232).
- Edition 2024 already warns on `unsafe_op_in_unsafe_fn`
  ([edition guide](https://doc.rust-lang.org/edition-guide/rust-2024/unsafe-op-in-unsafe-fn.html)).
  `rust_2024_compatibility` reports 0.

**Convention**

- `[lints.rust]` and `[lints.clippy]` in `Cargo.toml` set levels, and `priority`
  orders them. Lower numbers are overridden by higher ones, so a group goes at
  `priority = -1` and single lints override it. The table applies only to this
  package
  ([Cargo manifest](https://doc.rust-lang.org/cargo/reference/manifest.html)).
- Clippy groups: `all` (correctness, suspicious, style, complexity, perf; on by
  default), `pedantic` ("rather strict or have occasional false positives"),
  `nursery` (still under development), `cargo` (manifest), and `restriction`,
  which "should _emphatically_, not be enabled as a whole". Pick restriction
  lints one by one ([Clippy](https://doc.rust-lang.org/clippy/)).
- `clippy.toml` is found through `CLIPPY_CONF_DIR`, then `CARGO_MANIFEST_DIR`,
  then the current directory, walking up
  ([Clippy configuration](https://doc.rust-lang.org/clippy/configuration.html)).
  `allow-unwrap-in-tests`, `allow-expect-in-tests`,
  `allow-indexing-slicing-in-tests`, `allow-panic-in-tests`,
  `allow-print-in-tests` and `allow-dbg-in-tests` all default to `false`.
  `check-private-items` extends `missing_errors_doc`/`missing_panics_doc`/
  `missing_safety_doc` to private items
  ([Clippy lint configuration](https://doc.rust-lang.org/clippy/lint_configuration.html)).
- `#[expect(lint, reason = "...")]` suppresses a lint and warns
  (`unfulfilled_lint_expectations`) once the lint no longer fires. Every lint
  attribute accepts `reason`
  ([Reference: diagnostics](https://doc.rust-lang.org/reference/attributes/diagnostics.html)).
- The API Guidelines ask for `# Errors`, `# Panics` and `# Safety` doc sections
  (C-FAILURE,
  [API Guidelines](https://rust-lang.github.io/api-guidelines/documentation.html)).
  `missing_docs`, `unreachable_pub` and `unused_results` are allow-by-default
  rustc lints
  ([rustc lints](https://doc.rust-lang.org/rustc/lints/listing/allowed-by-default.html)).

### Measured cost

`cargo clippy --all-targets` on macOS, distinct locations:

| Lints                                   | Hits                                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `clippy::pedantic`                      | 26: `needless_pass_by_value` 7, `doc_markdown` 6, `borrow_as_ptr` 6, `unnecessary_wraps` 5, `missing_errors_doc` 1, `cast_lossless` 1 |
| `clippy::nursery`                       | 22: `missing_const_for_fn` 11, `use_self` 7, `option_if_let_else` 3, `or_fun_call` 1                                                  |
| `clippy::cargo`                         | 1: `multiple_crate_versions` (comes from dependencies)                                                                                |
| `unwrap_used`                           | 168 total, 0 outside tests with `allow-unwrap-in-tests`                                                                               |
| `expect_used`                           | 11 outside tests, all invariants (`"the model contains its children"`, `"events always serialize"`, `"unpoisoned"`)                   |
| `indexing_slicing`                      | 11 outside tests (`studio-fixture.rs`, `process/macos.rs`, `process/mod.rs:87`, `reaper.rs:286`)                                      |
| `undocumented_unsafe_blocks`            | 2 (`os/macos_accessibility.rs:131,164`)                                                                                               |
| `multiple_unsafe_ops_per_block`         | 7                                                                                                                                     |
| `allow_attributes_without_reason`       | 0                                                                                                                                     |
| `allow_attributes` (prefer `#[expect]`) | 4                                                                                                                                     |
| `print_stdout`/`print_stderr`           | 16 (the reaper's diagnostics go to stderr by design)                                                                                  |
| `missing_docs_in_private_items`         | 229                                                                                                                                   |
| `unreachable_pub`                       | 110                                                                                                                                   |
| `unused_results`                        | 49                                                                                                                                    |
| `unused_qualifications`                 | 3                                                                                                                                     |
| `unused_crate_dependencies`             | 2, false positives: each bin is checked alone                                                                                         |

With the must-have config below applied to a scratch copy: 36 warnings (26
pedantic, 7 `multiple_unsafe_ops_per_block`, 3 `unused_qualifications`) and 2
errors (`undocumented_unsafe_blocks`).

**Recommendation**

**Must-have:** the table below, plus clippy and fmt on every OS with
`--all-targets`.

```toml
# reaper/Cargo.toml
[lints.rust]
unsafe_op_in_unsafe_fn = "deny"
unused_qualifications = "warn"

[lints.clippy]
all = { level = "deny", priority = -1 }
pedantic = { level = "warn", priority = -1 }
# Restriction lints, picked one by one.
allow_attributes_without_reason = "deny"
undocumented_unsafe_blocks = "deny"
multiple_unsafe_ops_per_block = "warn"
unwrap_used = "deny"
dbg_macro = "deny"
todo = "deny"
unimplemented = "deny"
```

```toml
# reaper/clippy.toml
allow-unwrap-in-tests = true
```

```yaml
# native.yaml: run checks on one row per OS, linting tests too.
- name: Clippy
  if: ${{ matrix.checks }}
  run: >-
    cargo clippy --manifest-path reaper/Cargo.toml --target ${{ matrix.target }}
    --all-targets -- -D warnings

# matrix: add `checks: true` to the windows-latest x86_64 and macos-latest rows.
```

Not adopted: `expect_used`. In this crate `expect("…")` is how an invariant is
stated, the counterpart of the TypeScript rule "Invariants use `assert`".
`unwrap_used` already forces every panic site to carry a message.

**Nice-to-have:**

- `allow_attributes = "warn"`, so `#[allow]` becomes `#[expect]` and goes stale
  loudly (4 sites; the `cfg`-dependent ones in `studio-fixture.rs` already need
  `unfulfilled_lint_expectations`).
- `indexing_slicing = "warn"` with `allow-indexing-slicing-in-tests = true` (11
  sites).
- `unreachable_pub = "warn"` (110 sites, mechanical `pub` → `pub(crate)`). Do it
  with the crate split, which decides what `pub` means.
- Nursery lints one by one: `use_self` and `missing_const_for_fn` are cheap. Do
  not turn on the whole group, since its lints change between releases.
- Skip `missing_docs_in_private_items` (229) and `unused_results` (49): more
  noise than the TypeScript bar asks for.

### rustfmt

`cargo fmt --check` already runs. Of the options worth pinning, `newline_style`,
`use_field_init_shorthand` and `use_try_shorthand` are stable and produce 0
diffs today. `imports_granularity`, `group_imports`, `wrap_comments` and
`format_code_in_doc_comments` are unstable (nightly only)
([rustfmt Configurations.md](https://github.com/rust-lang/rustfmt/blob/main/Configurations.md)).
`style_edition` follows the Cargo edition (2024).

```toml
# reaper/rustfmt.toml
newline_style = "Unix"
use_field_init_shorthand = true
use_try_shorthand = true
```

## Supply chain and unused dependencies

**Convention**

- cargo-deny checks licenses, bans (specific crates and duplicates), advisories
  (vulnerable, unmaintained or yanked crates) and sources
  ([cargo-deny](https://embarkstudios.github.io/cargo-deny/checks/index.html)).
- cargo-machete is "fast (yet imprecise)": a heuristic on stable, with
  `[package.metadata.cargo-machete] ignored = [...]` for false positives
  ([cargo-machete](https://github.com/bnjbvr/cargo-machete)). cargo-udeps is
  more exact but needs nightly.
- typos uses a list of known misspellings instead of a dictionary, aiming for
  low false positives on code. It is configured in `typos.toml`, `_typos.toml`
  or `.typos.toml` ([typos](https://github.com/crate-ci/typos)).

### Measured

- `cargo deny check` with the config below: advisories ok, bans ok, licenses ok,
  sources ok. With only MIT, Apache-2.0 and Unicode-3.0 allowed, 5 crates fail:
  `libloading` (ISC), `option-ext` (MPL-2.0), `ustr` (BSD-2-Clause-Patent),
  `zstd-safe` and `zstd-sys` (BSD-3-Clause). Duplicate versions warn for
  `bitflags`, `getrandom`, `r-efi`, `syn` and `thiserror`.
- `cargo machete`: no unused dependencies.
- `typos reaper/src`: 0 findings. cspell (ESLint) does not read `.rs` files
  today; its cost on Rust was not measured.

**Recommendation (nice-to-have)**

```toml
# reaper/deny.toml
[advisories]
unmaintained = "workspace"
yanked = "deny"

[licenses]
allow = [
  "Apache-2.0",
  "BSD-2-Clause-Patent",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  "MPL-2.0",
  "Unicode-3.0"
]
confidence-threshold = 0.93

[bans]
multiple-versions = "warn"
wildcards = "deny"
deny = [ { name = "mockall", reason = "inject a trait and write a fake" } ]

[sources]
unknown-registry = "deny"
unknown-git = "deny"
```

`MPL-2.0` (weak copyleft, from `option-ext`) is the owner's call. Run cargo-deny
and cargo-machete in the `Native` workflow's checks row. typos can run from hk
over `reaper/**` next to cspell, which the repo already maintains.

## Sources

- \[Rust Book ch. 11.3]:
  <https://doc.rust-lang.org/book/ch11-03-test-organization.html>
- \[Cargo targets]:
  <https://doc.rust-lang.org/cargo/reference/cargo-targets.html>
- \[Cargo manifest, lints]:
  <https://doc.rust-lang.org/cargo/reference/manifest.html>
- \[Reference: diagnostics attributes]:
  <https://doc.rust-lang.org/reference/attributes/diagnostics.html>
- \[Edition guide: unsafe_op_in_unsafe_fn]:
  <https://doc.rust-lang.org/edition-guide/rust-2024/unsafe-op-in-unsafe-fn.html>
- \[rustc allowed-by-default lints]:
  <https://doc.rust-lang.org/rustc/lints/listing/allowed-by-default.html>
- \[rustc instrument-coverage]:
  <https://doc.rust-lang.org/rustc/instrument-coverage.html>
- \[Clippy]: <https://doc.rust-lang.org/clippy/>
- \[Clippy configuration]: <https://doc.rust-lang.org/clippy/configuration.html>
- \[Clippy lint configuration]:
  <https://doc.rust-lang.org/clippy/lint_configuration.html>
- \[Clippy lint list]:
  <https://rust-lang.github.io/rust-clippy/master/index.html>
- \[Rust API Guidelines: documentation]:
  <https://rust-lang.github.io/api-guidelines/documentation.html>
- \[rustfmt Configurations.md]:
  <https://github.com/rust-lang/rustfmt/blob/main/Configurations.md>
- \[cargo-llvm-cov README, 0.9.1]: <https://github.com/taiki-e/cargo-llvm-cov>
- \[cargo-mutants book, 27.1.0]: <https://mutants.rs/>
- \[cargo-mutants in-diff]: <https://mutants.rs/in-diff.html>
- \[cargo-mutants CI]: <https://mutants.rs/ci.html>
- \[nextest: why process-per-test]:
  <https://nexte.st/docs/design/why-process-per-test/>
- \[nextest: slow tests]: <https://nexte.st/docs/features/slow-tests/>
- \[nextest: retries]: <https://nexte.st/docs/features/retries/>
- \[nextest: leaky tests]: <https://nexte.st/docs/features/leaky-tests/>
- \[cargo-deny checks, 0.20.2]:
  <https://embarkstudios.github.io/cargo-deny/checks/index.html>
- \[cargo-machete, 0.9.2]: <https://github.com/bnjbvr/cargo-machete>
- \[typos, 1.51.1]: <https://github.com/crate-ci/typos>
- \[proptest book]: <https://proptest-rs.github.io/proptest/intro.html>
- \[mockall 0.15.0]: <https://docs.rs/mockall/latest/mockall/>
- \[napi features, 3.14.2]: <https://docs.rs/crate/napi/latest/features>
- \[napi-derive features]: <https://docs.rs/crate/napi-derive/latest/features>
