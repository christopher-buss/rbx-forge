---
status: accepted
---

# Native process ownership: reaper, detach, pipe, and packages

## Context

Spec #28 puts all process ownership in one Rust crate (`reaper/`): the
`forge-reaper` binary and the `@rbx-forge/native` addon. Four questions were
open before we build it (ticket #36):

1. Does job breakaway work for a detached `up` in Windows Terminal, the VS Code
   terminal, and an agent shell?
2. Can the reaper find marker-tagged processes of the same user on macOS by
   environment scan?
3. How do we ship the addon and the reaper binary prebuilt?
4. How do we test that the Windows pipe rejects remote clients?

We answered them with a throwaway spike (Rust, `windows-sys` and `libc`). It was
in commit `654ca6e` on branch `ticket/36-native-spike` under
`spikes/36-native/`, run locally and by a one-off workflow (run `36086083999`).
We removed it after this ADR; the product does not contain it.

## Measurements

### Windows job breakaway

The probe reports whether it is in a job and the job's limit flags, then starts
a detached child (`DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`) with and
without `CREATE_BREAKAWAY_FROM_JOB`. For hosts that we cannot start from a
script, the probe runs as a child of a live host shell through
`PROC_THREAD_ATTRIBUTE_PARENT_PROCESS`; the child then inherits the host's job.
A control run proved this: under a parent in a job without breakaway rights, the
probe is in the job and breakaway fails with error 5.

Windows 11 Pro 26100, Windows Terminal 1.24, VS Code 1.139, Claude Code desktop:

| Host                                        | Shell in a job | Breakaway spawn | Child in a job | Child alive after host ends |
| ------------------------------------------- | -------------- | --------------- | -------------- | --------------------------- |
| Agent shell: Claude Code Bash (Git Bash)    | no             | ok              | no             | yes (next tool call)        |
| Agent shell: Claude Code PowerShell         | no             | ok              | no             | yes (next tool call)        |
| Agent shell: Codex (via parent)             | no             | ok              | no             | not measured                |
| Windows Terminal, new window via `wt`       | no             | ok              | no             | yes (tab closed on exit)    |
| Windows Terminal pwsh tab (via parent)      | no             | ok              | no             | not measured                |
| VS Code terminal pwsh (via parent)          | no             | ok              | no             | **not measured**            |
| GitHub Actions `windows-latest` step (bash) | yes, flags 0x0 | **error 5**     | yes            | not measured                |

`WindowsTerminal.exe`, `claude.exe`, and `codex.exe` are themselves in a job,
but their shells are not: those jobs let children break away silently.

Forge-made jobs (local and CI):

| Job flags                                  | Breakaway spawn | After job close: plain child | After job close: breakaway child |
| ------------------------------------------ | --------------- | ---------------------------- | -------------------------------- |
| `KILL_ON_JOB_CLOSE`                        | error 5         | killed                       | -                                |
| `KILL_ON_JOB_CLOSE \| BREAKAWAY_OK`        | ok              | killed                       | alive                            |
| `KILL_ON_JOB_CLOSE \| SILENT_BREAKAWAY_OK` | ok              | alive (never in the job)     | alive                            |

Nested inside the CI runner's job, a breakaway child leaves only the inner job
that allows it; it stays in the runner's outer job, and the spawn still
succeeds.

### macOS environment scan

The scan lists all PIDs (`proc_listallpids`), reads uid and start time
(`proc_pidinfo PROC_PIDTBSDINFO`), and reads the environment through
`sysctl KERN_PROCARGS2`. Seven workers carried `RBX_FORGE_SESSION`:

| Worker                                    | Found | Expected |
| ----------------------------------------- | ----- | -------- |
| `/bin/sleep` (platform binary)            | yes   | yes      |
| `sh -c 'sleep &'` orphan after `sh` exits | yes   | yes      |
| double fork `( sleep & )`                 | yes   | yes      |
| `node` (signed third-party binary)        | yes   | yes      |
| `unsetenv` in process, no exec            | yes   | yes      |
| overwrites its env strings in place       | no    | no       |
| `exec` with the marker removed            | no    | no       |

| Runner                       | Same-uid readable | Other-uid     | Scan time (warm) |
| ---------------------------- | ----------------- | ------------- | ---------------- |
| `macos-latest` (26.6, arm64) | 287 of 287        | 248, no info  | 4.6 ms           |
| `macos-15-intel` (15.7, x64) | 287 of 287        | 231, no info  | 20 ms            |
| `ubuntu-latest` (`/proc`)    | 12 of 16          | 140, `EACCES` | 2.8 ms           |

`KERN_PROCARGS2` returns the original environment block, so `unsetenv` does not
hide a worker; only an in-place overwrite or an `exec` with a scrubbed
environment hides it. Processes of other users are invisible (`proc_pidinfo`
fails), which is correct for a same-user tool. Platform binaries under SIP and
signed third-party binaries do not block the read for the same user.

### Windows pipe remote rejection

The pipe is created with the DACL `O:<user>D:P(A;;GA;;;<user>)`,
`PIPE_REJECT_REMOTE_CLIENTS`, and `FILE_FLAG_FIRST_PIPE_INSTANCE`. Results were
identical on this machine and on `windows-latest` (`LanmanServer` running on
both):

| Client path                       | Reject flag | Accept flag (control) | Default DACL + reject |
| --------------------------------- | ----------- | --------------------- | --------------------- |
| `\\.\pipe\<name>`                 | ok          | ok                    | ok                    |
| `\\127.0.0.1\pipe\<name>`         | error 5     | ok                    | error 5               |
| `\\localhost\pipe\<name>`         | error 5     | ok                    | error 5               |
| `\\<COMPUTERNAME>\pipe\<name>`    | error 5     | ok                    | error 5               |
| `\\--1.ipv6-literal.net\pipe\...` | error 5     | ok                    | error 5               |
| `\\.\pipe\<name>` as anonymous    | error 5     | error 5               | error 5               |

- A second `FILE_FLAG_FIRST_PIPE_INSTANCE` create fails with error 5.
- The DACL reads back as `D:P(A;;FA;;;<user>)` (`GA` maps to `FA`). On the CI
  runner the SID prints as the alias `LA`, so tests must compare SIDs, not SDDL
  text.
- The default pipe DACL grants read to Everyone (`WD`) and Anonymous (`AN`).
  This confirms the explicit DACL is necessary.
- The anonymous client is denied under the default DACL too, so it does not
  prove our DACL. It is not a stand-in for "another local user".

### Packages

- `napi create-npm-dirs` (CLI 3.10.5) makes `npm/<platform>/package.json` with
  `files` equal to only `forge-native.<platform>.node`. It does not know about
  the reaper binary.
- On Linux and macOS, `npm pack` keeps the file mode and both npm and pnpm 11
  install it as packed: 0755 stays executable, 0644 stays not executable.

## Policy

- **Detach.** `up` launches the supervisor with
  `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB`. If
  `CreateProcessW` fails with `ERROR_ACCESS_DENIED`, `up` fails with
  `detach_unsupported` (exit 1). There is no retry without breakaway. A
  successful spawn is final, even if the child stays in an outer job that allows
  no breakaway (we cannot see the outer job's flags). `start` never uses
  breakaway.
- **macOS marker scan.** Use `KERN_PROCARGS2` for the environment and
  `PROC_PIDTBSDINFO` for uid and start time (second and microsecond). Scan only
  processes of the current uid. The accepted limit from spec #28 stays, and is
  now more exact: a descendant hides from the scan only if it overwrites its
  environment strings in place or `exec`s without the marker, **and** closes the
  inherited lease descriptor.
- **Pipe security.** Keep the spec: explicit current-user DACL, reject remote
  clients, first-instance flag, token as the first message.
- **Remote-client test (S4).** An integration test on Windows creates the real
  forge pipe, then connects through `\\127.0.0.1\pipe\<name>` and
  `\\localhost\pipe\<name>` and expects `ERROR_ACCESS_DENIED`. The same test
  first proves that the loopback path is live: a control pipe with
  `PIPE_ACCEPT_REMOTE_CLIENTS` must accept a client through the same path. If
  the control fails (for example `LanmanServer` is stopped), the test fails; it
  never passes without proof.
- **Pipe DACL test (S5).** Read back the security descriptor and assert the
  owner and exactly one allow ACE, both the current user's SID, compared as
  SIDs.

## Architecture

- **One crate, two artifacts.** `reaper/` builds the `forge_native` cdylib
  (napi) and the `forge-reaper` binary. The binary never links napi.
- **Per-platform packages.** The release workflow builds both artifacts per
  target (the existing `native` CI matrix), then in one publish job:
  1. `napi create-npm-dirs` makes `npm/<platform>/`.
  2. `napi artifacts` copies each `.node` file into its directory.
  3. A small repo script copies `forge-reaper` (`.exe` on Windows) into the same
     directory, adds it to `files`, and sets mode 0755. Upload and download
     artifact steps do not keep file modes, so this step must set the mode.
  4. The workflow checks each tarball (`npm pack --dry-run` and `tar tvzf`):
     both files are present and the reaper is 0755.
  5. `napi pre-publish` publishes `@rbx-forge/native-<platform>` and writes them
     to the `optionalDependencies` of `rbx-forge`. `packageName`
     `@rbx-forge/native` is only the name prefix; there is no separate umbrella
     package.
- **Loader.** A TypeScript module in the native-bindings area (no napi generated
  JS; the build already uses `--no-js`) picks the package from
  `process.platform`, `process.arch`, and glibc or musl. It loads the addon with
  `createRequire`, and resolves the reaper path from the package's
  `package.json`. If the package is missing or the reaper is not executable, it
  returns the typed error `native_missing`. It does not `chmod` at run time,
  because pnpm hard-links package files from its shared store.
- **Development and tests.** The loader takes an explicit directory through its
  seam. Tests and local runs point it at `reaper/target` output.
- **Targets.** The eight targets in `package.json#napi` stay.

## Consequences

- On GitHub-hosted Windows runners, a plain `up` gets `detach_unsupported`,
  because the step's job has no breakaway rights. E2E tests for `up` on Windows
  must run the CLI inside a harness job with `BREAKAWAY_OK | KILL_ON_JOB_CLOSE`
  (this works nested in the runner's job), and one test must assert
  `detach_unsupported` inside a job without `BREAKAWAY_OK`. The harness needs
  native job code in the test support (the addon can expose it for tests only).
- The terminals we use today put no job on their shells, so `up` works there.
  Hosts that change this get a clear error, not a leaked or killed supervisor.
- The release workflow owns a step that the napi CLI does not have (adding the
  reaper binary). We must keep it when we update `@napi-rs/cli`.
- The S4 test needs the SMB server service on the Windows machine. It is running
  on `windows-latest` and by default on Windows 10 and 11.

## Not measured

- VS Code terminal: whether closing the terminal panel kills a detached,
  broken-away process. We measured only that its shells are in no job. We expect
  the process to survive (no job, no console), as in Windows Terminal. Fallback:
  none needed for `up`; if a future test shows a kill, treat VS Code as a host
  that forbids detach.
- Survival after the Codex and VS Code hosts end: not measured; same
  expectation.
- A real second local user against the pipe DACL (S3). Fallback: the S5
  exact-DACL assertion. A CI job that creates a local user is possible later.
- A full publish dry run (`napi artifacts` and `napi pre-publish`) and the
  static MSVC runtime for the Windows binary: to verify in the release ticket.
- macOS lease detection through `PROC_PIDLISTFDS`: out of scope for this spike.
