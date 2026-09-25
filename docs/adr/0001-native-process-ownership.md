---
status: accepted
---

# Native process ownership: reaper, detach, pipe, and packages

## Context

All process ownership is in one Rust crate (`reaper/`): the `forge-reaper`
binary and the `@rbx-forge/native` addon. Four questions shape its design:

1. Does job breakaway work for a detached `up` in Windows Terminal, the VS Code
   terminal, and an agent shell?
2. Can the reaper find marker-tagged processes of the same user on macOS by
   environment scan?
3. How do we ship the addon and the reaper binary prebuilt?
4. How do we test that the Windows pipe rejects remote clients?

The measurements below come from a throwaway probe (Rust, `windows-sys` and
`libc`), run locally and on CI. The product does not contain it.

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
- On Linux and macOS, `npm pack` keeps the file mode and both npm and pnpm
  install it as packed: 0755 stays executable, 0644 stays not executable.

### Roblox Studio (Windows)

Studio 0.740, Windows 11. A direct `RobloxStudioBeta.exe <place>` (the command
the registry gives for `.rbxl` files and `roblox-studio:` links) opens the place
for normal use. It does not hand off to another process: the spawned PID stays,
and the place's lock file names it. Studio survives the exit of its parent.
Window states after `WM_CLOSE` to the main window:

| Case                                 | Main window            | Lock file gone | Process exit |
| ------------------------------------ | ---------------------- | -------------- | ------------ |
| Studio-saved place, loaded           | enabled throughout     | 1.0-1.4 s      | 2.6-3.3 s    |
| `rojo build` place ("Save changes?") | disabled after 80 ms   | never          | never        |
| While "Opening place" shows          | disabled (from before) | never          | never        |

- Studio is Qt: its dialogs are owned `Qt5159QWindowIcon` windows, not `#32770`.
  A graceful close also shows a short-lived owned window, so a new owned window
  is no dialog signal. A disabled main window is: Windows disables the owner of
  a modal dialog, and the disabled window drops `WM_CLOSE`.
- Studio has many hidden, unowned helper windows titled `RobloxStudio`; its main
  window is titled `<place> - Roblox Studio` (`Roblox Studio` while it loads).
- Through forge (`up`, then `down` or `stop`, CLI run included): open to loaded
  10-11 s; close of a saved place 1.8-2.0 s (lock release, then kill); "Save
  changes?" 1.3-1.5 s (dialog, then kill).

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
  processes of the current uid. Accepted limit: a descendant hides from the scan
  only if it overwrites its environment strings in place or `exec`s without the
  marker, **and** closes the inherited lease descriptor.
- **POSIX forced stop.** Each pass sends `SIGKILL` to the worker's group (its
  unreaped leader pins the group id), then lists the process table and kills
  every process outside the group that started after the leader and carries the
  session and worker markers. Such a kill goes only through a pin (pidfd on
  Linux, start-time check on macOS) after the pinned process shows the listed
  start time and both markers. A killed process counts as alive until its pin
  sees it gone. The loop ends after two empty passes in a row (a process inside
  `exec` reads an empty environment for a moment) or at the 5 s bound, and the
  `exited` report lists the survivors. Nothing is reaped during a loop. A Linux
  process whose main thread is a zombie while other threads still run counts as
  alive: its parent cannot reap it yet.
- **POSIX `SIGTERM`.** The reaper blocks `SIGTERM` and waits for it on one
  thread; it means the host is gone, as stdin EOF does: every tree is forced,
  then `terminated` is written. On Linux the reaper sets `SIGTERM` as its
  parent-death signal and is a child subreaper. Before it writes `terminated`,
  it kills every child that is not a worker leader: orphans it adopted, also
  ones that scrubbed their markers.
- **Forced-stop bound.** The reaper's per-worker loop has a 5 s bound. The host
  escalates `terminate` after `graceMs + 5 s`; a 10 s loop could never report
  `incomplete` before that escalation fires. Forced cleanup (below) has a 10 s
  bound.
- **Session evidence.** A process belongs to a session when its environment
  holds `RBX_FORGE_SESSION=<id>`, or it holds a descriptor on the session's
  lease (POSIX: `/proc/<pid>/fd`; macOS: `PROC_PIDLISTFDS` and
  `PROC_PIDFDVNODEINFO`, compared by device and inode), or it is the reaper the
  record names (PID and start time). On Windows the evidence is the session's
  named jobs, found through the job serials in the reaper record, and recorded
  leaders that still die after their job closed. The calling process and its
  ancestors never count.
- **Barriers.** A barrier is clear when the lease can be taken exclusively and a
  scan finds no process of the session. The probe (`isLockFree`) never creates
  the lease, so `down`, which probes without the singleton lock, never races the
  delete of a session directory. The reaper exits with its lease held and its
  record kept, so no barrier reads clear while it still runs. Startup waits
  `graceMs + 15 s` per old session, then fails with `previous_generation_alive`
  and the PIDs. The final barrier waits 5 s, then fails with
  `cleanup_in_progress`.
- **Forced cleanup.** `start --force` (and the host's last escalation step) runs
  it in the addon on a libuv thread. POSIX: each pass pins every member, reads
  its evidence again through the pin, and kills it, deepest in the tree first;
  the recorded reaper only when nothing else is alive or unverifiable. The loop
  ends after two empty passes or at 10 s. Windows: terminate each recorded job,
  wait until it is empty, then kill the verified reaper. A member whose evidence
  cannot be read again is reported (`cleanup_unverifiable`) and never killed.
- **Accepted limit: scrubbed descendants.** A POSIX descendant that removes the
  marker from its environment **and** closes the inherited lease leaves no
  evidence; no scan finds it. Node closes inherited descriptors in its children,
  so a Node worker's descendants keep only the marker.
- **Pipe security.** Explicit current-user DACL, reject remote clients,
  first-instance flag, token as the first message.
- **Studio.** forge starts the Studio executable directly with the place as its
  only argument: on Windows through the addon with the flags of **Detach** (a
  job that forbids breakaway falls back to the platform launcher), on POSIX
  detached in a new session. It pins the process at once. A close is a close
  request, then a poll every 50 ms: the kill comes at once when the lock file
  goes or a main window is disabled (a modal dialog), else after 15 s. A main
  window is a visible, unowned, non-tool, non-console window; with none, a
  hidden unowned window titled `… - Roblox Studio` counts, so a Studio started
  hidden (the e2e stand-in) still gets the request.
- **Remote-client test.** An integration test on Windows creates the real forge
  pipe, then connects through `\\127.0.0.1\pipe\<name>` and
  `\\localhost\pipe\<name>` and expects `ERROR_ACCESS_DENIED`. The same test
  first proves that the loopback path is live: a control pipe with
  `PIPE_ACCEPT_REMOTE_CLIENTS` must accept a client through the same path. If
  the control fails (for example `LanmanServer` is stopped), the test fails; it
  never passes without proof.
- **Pipe DACL test.** Read back the security descriptor and assert the owner and
  exactly one allow ACE, both the current user's SID, compared as SIDs.

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
- **Targets.** The eight targets in `package.json#napi` stay. CI loads the addon
  on each: musl targets build in `rust:alpine` (a glibc host links the glibc
  loader into the addon) and load in `node:alpine`; `x86_64-apple-darwin` loads
  on the Intel runner `macos-15-intel`.

## Consequences

- On GitHub-hosted Windows runners, a plain `up` from a step shell gets
  `detach_unsupported`, because the step's job has no breakaway rights. The `up`
  e2e tests need no harness: vitest's own libuv job allows breakaway, so the
  nested breakaway succeeds (the rule above). The `detach_unsupported` e2e test
  runs the CLI inside a job without `BREAKAWAY_OK`
  (`test/fixtures/bin/in-job.ts`).
- The terminals we use put no job on their shells, so `up` works there. Hosts
  that change this get a clear error, not a leaked or killed supervisor.
- The release workflow owns a step that the napi CLI does not have (adding the
  reaper binary). We must keep it when we update `@napi-rs/cli`.
- The remote-client test needs the SMB server service on the Windows machine. It
  is running on `windows-latest` and by default on Windows 10 and 11.

## Not measured

- Studio: a direct launch on macOS; a logged-out Studio; whether moving an
  auto-recovery file out of AutoSaves stops the recovery prompt (Studio writes
  one only every few minutes).
- VS Code terminal: whether closing the terminal panel kills a detached,
  broken-away process. We measured only that its shells are in no job. We expect
  the process to survive (no job, no console), as in Windows Terminal. Fallback:
  none needed for `up`; if a future test shows a kill, treat VS Code as a host
  that forbids detach.
- Survival after the Codex and VS Code hosts end: not measured; same
  expectation.
- A full publish dry run (`napi artifacts` and `napi pre-publish`) and the
  static MSVC runtime for the Windows binary.
- macOS lease detection through `PROC_PIDLISTFDS`.
