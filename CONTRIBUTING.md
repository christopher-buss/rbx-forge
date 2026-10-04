# Contributing to rbx-forge

## Setup

1. `mise install` (Node, pnpm, hk, pkl, Rust, Rojo, Luau).
2. `pnpm install`.
3. `hk install --global --mise` to install the git hooks
   (<https://hk.jdx.dev/mise_integration.html#make-tools-available-to-git>)

## Worktrees

New worktrees come from [worktrunk](https://worktrunk.dev) (`wt`). Its project
hooks (`.config/wt.toml`) trust and install the mise tools, run `pnpm install`,
copy the `.worktreeinclude` files, then run `pnpm build:all` in the background.

- `wt switch --create <branch>` runs them directly.
- Claude Code runs them through its `WorktreeCreate` and `WorktreeRemove` hooks
  (`.claude/settings.json`, `scripts/worktree/`). The new branch starts from the
  fetched `origin` default branch.
- T3 Code runs them through its setup script (`t3.json`).

## Scripts

| Script                        | What it runs                                    |
| ----------------------------- | ----------------------------------------------- |
| `pnpm build`                  | tsdown bundle of the CLI into `dist/`           |
| `pnpm build:all`              | `build:native`, `build:reaper`, then `build`    |
| `pnpm typecheck`              | `tsc --build` with TypeScript 7                 |
| `pnpm lint` / `pnpm lint:fix` | oxlint, then ESLint (`isentinel-lint`)          |
| `pnpm knip`                   | unused files, exports, and dependencies         |
| `pnpm test:unit`              | unit project with 100% coverage                 |
| `pnpm test:integration`       | real processes (run `build:all` first)          |
| `pnpm test:e2e`               | the built CLI as a subprocess (run `build:all`) |
| `pnpm build:native`           | the Rust crate in `reaper/` through napi-rs     |
| `pnpm build:reaper`           | the `forge-reaper` binary, next to the addon    |
| `pnpm mutation`               | Stryker mutation testing                        |
| `pnpm release`                | pick a version, run the gate, then tag          |

## Before a commit

The pre-commit hook runs lint and typecheck. With the agent profile, it also
builds and runs the unit, integration, and e2e suites for changes under `src/`,
`test/`, or `scripts/`, or to the package manifest, dependency lockfile and
workspace config, TypeScript configs, tsdown config, or Vitest configs. Changes
under `reaper/` run the native build.

The agent pre-push hook runs mutation tests only when `src/` differs from the
merge-base with `origin/main`, including pushes to a remote URL. Keep
`origin/main` available and current with `git fetch origin`. Knip runs on every
push. CI runs the full checks for every change that is not docs-only.

Run the rest by hand, or all of it with `hk check`:

```bash
pnpm lint
pnpm typecheck
pnpm knip
pnpm build
pnpm build:native
pnpm test
pnpm test:e2e
cargo test --manifest-path reaper/Cargo.toml
cargo clippy --manifest-path reaper/Cargo.toml --all-targets -- -D warnings
```

## Native addon

The integration and e2e tests load the addon from `reaper/target/napi`, so run
`pnpm build:native` after a change in `reaper/`. To run the CLI from a checkout,
set `RBX_FORGE_NATIVE_DIR` to that directory; without it, forge loads the
`@rbx-forge/native-<platform>` package.

- `reaper/src/os/`: the OS primitives (file locks, process start times, pinned
  processes). Both the addon and the `forge-reaper` binary compile it; its Rust
  tests run through the binary target (`cargo test`).
- `reaper/src/lib.rs`: the napi layer, types and errors only.
- `src/native/addon.ts`: the same surface in TypeScript, written by hand. Change
  it with `lib.rs`.

## Releases

`pnpm release` (bumpp) asks for the next version, then runs the release gate
(`scripts/release/check.ts`, the `preversion` script) before it changes a file.
The gate needs a clean `main` equal to `origin/main`, then runs typecheck, lint,
knip, `build:all`, `cargo test`, and the unit, integration, and e2e projects. A
failure stops the release with no change.

- On Windows the gate sets `RBX_FORGE_TEST_REAL_STUDIO=1`: the real-Studio
  specs, which CI never runs, run here. Install Studio and log in first; the
  specs open Studio windows.
- On macOS the gate runs the rest; the real-Studio specs are Windows only.
- Release only when CI is green for HEAD; the gate does not check it.

When the gate passes, bumpp commits `chore: release vX.Y.Z`, tags `vX.Y.Z`, and
pushes. The tag starts `.github/workflows/release.yaml`: it builds every napi
target (`native.yaml`, the same build as CI), publishes the
`@rbx-forge/native-<target>` packages and then `rbx-forge` through npm trusted
publishing, and makes the GitHub release with changelogithub. A tag releases a
stable version only.

### First publish

npm trusted publishing needs each package on npm first. Once, from Windows or
macOS, logged in to npm:

1. Push `main` and wait for CI to pass for HEAD.
2. `pnpm release:bootstrap 2.0.0-rc.0`: downloads the `native-*` artifacts of
   that CI run, builds, and publishes every platform package, then `rbx-forge`,
   on dist-tag `next`.
3. On npmjs.com, add a trusted publisher to each package: this repository,
   workflow `release.yaml`.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/):
`<type>(<scope>): <subject>`. The commit-msg hook checks the format. See
[.github/commit-instructions.md](./.github/commit-instructions.md).
