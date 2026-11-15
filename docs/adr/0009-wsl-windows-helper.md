---
status: proposed
---

# WSL drives Windows Studio through a Windows helper

Under WSL, forge runs as Linux, but Studio runs as Windows. A Linux process
cannot load the Windows addon, and the PID of an interop child is a Linux PID,
not Studio's. Each forge process under WSL (CLI, supervisor, detached watcher)
starts its own **Windows helper** on first use: a Windows binary from the same
crate that serves Studio operations as NDJSON over stdio. It finds, launches,
pins, closes, saves, hides, and dismisses dialogs for Studio with the same Rust
code as the addon, so a Studio under WSL has the same identity guarantee as on
Windows: a held handle, never a bare PID.

Studio code uses one async Studio-process interface: the addon behind it on
Windows and macOS, the helper behind it under WSL. Behavior follows Studio's OS,
not the host's. Worker, lock, and IPC calls stay synchronous and Linux-local.
Native Linux, outside WSL, still has no Studio.

## Decisions

- **Helper protocol.** Versioned handshake (protocol, helper and Windows
  architecture, Windows host name), request ids, deadlines. forge starts the
  packaged helper by its absolute path. At stdin EOF the helper closes its
  handles and exits; it never closes Studio.
- **Unknown launch.** A launch whose reply is lost is `studio_launch_unknown`:
  forge never launches again and never falls back to the platform launcher.
- **Identity.** A Studio under WSL is a Windows PID with a Windows start time.
  The lock file's host is checked against the helper's Windows host name. The
  state contract marks the Studio's OS; the supervisor stays a Linux identity.
- **Discovery.** The helper reads the registry. `RBX_FORGE_STUDIO_PATH` and
  `--studio-path` take a Linux path or an absolute Windows path.
- **Paths.** Node keeps Linux paths. `wslpath` converts at the helper boundary
  (`-w` toward Windows, `-u` back). `wslpath` accepts much bad input with exit
  0, so forge passes it only absolute paths, trims the `\r` of Windows output,
  and checks each result. Studio's environment is the helper's Windows
  environment plus named overrides.
- **Sides.** The identity record names its side and is written before any part
  starts. A forge never joins, scans, forces, or deletes a session of the other
  side, and keeps the record until cleanup is proved on its own side. For a
  project on a Windows drive, the WSL supervisor also takes the Windows
  singleton lock through its helper: on drvfs, Linux `flock` and Windows
  `LockFileEx` do not see each other. Windows cannot lock a file under
  `\\wsl.localhost`, so a project on the Linux file system has no Windows lock.
  A free Windows lock alone proves nothing.
- **Helper channel loss.** A helper's stdio relays through the `wsl.exe` that
  owned the Linux session when it started, so closing that terminal ends the
  helper. Unexpected EOF, EPIPE, or exit is channel loss and starts bounded
  recovery; the session continues. The replacement passes the handshake, retakes
  the Windows lock where supported, and re-pins Studio by Windows PID and start
  time before any command. A command whose result was lost is never sent again.
  Failed recovery leaves Studio control unavailable and keeps the side record.
  Watchers and CLI commands recover the same way, within their own deadlines; a
  helper loss never closes Studio or ends the session.
- **Network.** Listeners stay on loopback and rely on WSL localhost forwarding
  or mirrored networking. The helper probes Rojo and the capture listener from
  the Windows side through `127.0.0.1`, never `localhost` and never the
  readiness route; a failed probe is `wsl_network_unreachable`. There is no
  relay.
- **Rojo plugin.** The session's own Rojo installs its plugin under a temporary
  `HOME`, with `ROBLOX_STUDIO_PATH` at a temporary folder that holds `content/`;
  forge checks and patches the model, then writes it to the Windows Plugins
  folder. For a Rojo whose install behavior is not verified, forge asks for a
  manual connection. forge downloads nothing.
- **Errors.** `wsl_interop_unavailable` when interop is off or broken;
  `windows_helper_unavailable` when the helper file is missing or cannot run.
- **Packages.** Each Linux platform package carries the Windows helper of its
  own architecture, mode 0755. A WSL distro runs on the Windows kernel's
  architecture.

## Considered options

- `taskkill.exe` with the lock file's PID: kills a process forge cannot verify.
- A Windows `node.exe` forge for Studio: a second install and a second version.
- One helper per call: a close (request, poll, kill) must act on one held
  handle.
- A Windows-side relay for the capture channel: a new listener outside ADR 0008.
- `WSL_INTEROP=/run/WSL/1_interop` for a helper that outlives the terminal:
  undocumented WSL internals.
- A helper that connects back to the supervisor over loopback TCP: survives a
  closed terminal, but Studio control would need a wider exception to ADR 0003
  than capture has.
- Downloading `Rojo.rbxm`: a network dependency for a model the session's Rojo
  already holds.

## Consequences

- The helper is tested on Windows CI. Real Studio under WSL2 gates each release
  through a recorded run of the packed package.
- A forge older than this decision on the other side does not read the side and
  is not excluded.
- WSL2 3.0.5, NAT: an interop-started process is in no job, and Studio outlives
  its parent, the helper, and the Linux process that started it. A helper gets
  stdin EOF when its Linux writer ends or when the `wsl.exe` that relays its
  stdio is killed. Studio opens, locks, runs RunScript on, saves, and closes a
  place under `\\wsl.localhost`. Structured data goes through stdin, never
  interop argv.
- Not measured: WSL2 on hosted Windows runners; an interop start inside a job;
  mirrored networking.
