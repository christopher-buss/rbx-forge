<!-- cspell:words drvfs wslinfo osrelease -->

# WSL release gate

The maintainer completes this gate **before `pnpm release` or creating a release
tag**. A Windows helper integration pass, a fake-helper Linux pass, or a hosted
VM capability report does not replace it. `preversion` runs local checks and
Windows real Studio; it does not certify this manual matrix. Release CI packages
and publishes tags, so a tag must not be created while any required cell is
failed or unrun. [Current evidence](./validation/wsl-297.md) records the open
gate.

Use the final dependency-complete commit, build its Windows and Linux artifacts,
and stage the Linux platform package with the matching Windows helper. Use
`scripts/release/release.ts` packaging and `pnpm pack` so workspace catalogs
become published dependency versions. Never publish test packages to npm.
Install the root and native tarballs into a clean Linux directory with optional
dependencies enabled. Keep the untouched installation for the CLI smoke test.

Record commit and dirty diff, intended release version, tarball SHA-256 hashes,
tar entry modes (helper and reaper 0755), installed paths, architecture, native
build provenance, Linux Node/pnpm/Rojo versions, Windows/WSL/kernel/Studio
versions, and effective networking mode. The checkout's version alone is not the
first supported release: published v2.3.0 predates WSL support. Record the exact
minimum release needed on **both** Windows and WSL before publication.

Run with genuine Linux Node (24.12 or newer), Linux pnpm's JS entry, and genuine
Linux Rojo 7.7.1. Do not let a Windows pnpm shim select Windows Node. Confirm
`node -p process.platform` prints `linux` and `uname -r` identifies WSL2.
Windows Studio must already be installed and logged in. Run tests serially.

For each cell, set an owned temporary directory on the required file system,
verify `stat -f -c %T "$TMPDIR"` and `wslinfo --networking-mode`, then run:

```bash
export RBX_FORGE_TEST_REAL_WSL_STUDIO=1
export RBX_FORGE_TEST_REAL_ROJO=/absolute/path/to/linux/rojo
export RBX_FORGE_TEST_PACKED_INSTALL=/absolute/install/node_modules/rbx-forge
export RBX_FORGE_TEST_WSL_NETWORK=nat # mirrored for the other mode
export RBX_FORGE_TEST_WSL_FILESYSTEM=drvfs # ext4 for the Linux file system
export RBX_FORGE_TEST_REAL_STUDIO_LOG=/absolute/evidence/cell.ndjson
node /absolute/path/to/linux/pnpm/bin/pnpm.mjs exec vitest run \
  --project e2e-real-wsl-studio
```

`TMPDIR` selects fixture location. Keep the test checkout, dependencies and
evidence outside the temporary fixture directories. The shared real-Studio suite
runs captures, syncback, found attach/reconnect, snapshots, saves, visibility,
both detached watchers and cleanup with Windows PID/start-time pins. It copies
the packed installation for private plugin filenames and token gates, verifies
canonical plugins' bytes and modification times, and never edits another Studio.
This isolated copy is instrumented. The additional found-Studio smoke case runs
the **untouched packed CLI**, without a development native-directory override.

The lost-reply case uses a transparent Linux transport proxy around the actual
packaged Windows helper. It drops one completed menu-save reply, records the
original reply, and checks completion without a repeated save. It fabricates no
helper operation or response. No fake-helper result counts toward this gate.

| Project file system                     | Networking                        | Required outcome           |
| --------------------------------------- | --------------------------------- | -------------------------- |
| ext4, exposed to Studio through WSL UNC | NAT, localhost forwarding enabled | All real-Studio cases pass |
| Windows drive (drvfs)                   | NAT, localhost forwarding enabled | All real-Studio cases pass |
| ext4, exposed to Studio through WSL UNC | Mirrored                          | All real-Studio cases pass |
| Windows drive (drvfs)                   | Mirrored                          | All real-Studio cases pass |

Also record these manual checks in each networking mode:

1. In an **owned** launch terminal, run the packed CLI's `up --studio`, record
   Studio's Windows PID/start time and `control: ready`, then close that
   terminal. In a fresh terminal, verify the same Studio survives and
   save/show/hide/down regain control. Never close another terminal or terminate
   a distro for this.
2. Repeat terminal loss with a hidden session's keep-hidden watcher and a hidden
   snapshot's Lighting watcher. Trigger a new owned window and delayed Lighting
   prompt; check both watchers recover and a later `show` remains effective.
3. Lose launch and close replies through real interop. Record the unknown launch
   outcome with one Studio, and an uncertain close with no forced-kill
   escalation. Verify unavailable control retains its side record and fresh
   verified exit permits later cleanup. A recorded unknown outcome is an
   expected assertion, not permission to repeat the mutation.
4. On drvfs, try Windows and WSL simultaneously with matching supported builds.
   Check exclusion and foreign-side refusal for join, scan, force and cleanup;
   then stop the session on its own side. Exercise registry discovery and both
   Linux and Windows explicit executable paths.
5. With NAT forwarding disabled, verify `wsl_network_unreachable` and its repair
   hint. Restore forwarding and prove a fresh session works. Coordinate all WSL
   and Docker workloads before changing networking or restarting WSL.

Retain redacted NDJSON, full test results, timestamps, per-case outcomes,
cleanup evidence and the Windows 2025 job URL/summary/artifact. Record skipped
and failed checks explicitly. Run lint, typecheck, knip, unit coverage, Rust,
integration, e2e, Windows plugin tests and mutation at the unchanged 100% floor.
Record macOS, ARM64 and other-user CI separately from local results. Accept ADR
0009 only after the evidence supports acceptance; an incomplete matrix keeps it
proposed.

The bounded Windows 2025 CI job records image/version/architecture and each
command's stdout, stderr, exit code and timeout in `report.json`. It provisions
Ubuntu when absent, proves a WSL2 kernel through actual Linux execution, then
tries an owned Windows fixture through the real helper. VM unavailability,
provisioning failure, and lifecycle failure are distinct states. After the VM
runs, a failed helper test fails the job; it is never treated as unsupported
capability. Image documentation listing WSL does not establish that its VM runs.

References:
[WSL commands](https://learn.microsoft.com/en-us/windows/wsl/basic-commands),
[Windows 2025 runner image](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md).
