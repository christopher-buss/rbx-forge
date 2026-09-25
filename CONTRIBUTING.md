# Contributing to rbx-forge

## Setup

1. `mise install` (Node, pnpm through corepack, hk, pkl, Rust, Rojo).
2. `pnpm install`.
3. `mise run install-hk` to install the git hooks.

See the script table in [README.md](./README.md).

## Before a commit

The pre-commit hook runs lint and typecheck. Run the rest by hand, or all of it
with `hk check`:

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

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/):
`<type>(<scope>): <subject>`. The commit-msg hook checks the format. See
[.github/commit-instructions.md](./.github/commit-instructions.md).
