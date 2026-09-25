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
pnpm test
pnpm test:e2e
cargo build --manifest-path reaper/Cargo.toml
```

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/):
`<type>(<scope>): <subject>`. The commit-msg hook checks the format. See
[.github/commit-instructions.md](./.github/commit-instructions.md).

## Dependencies

Versions live in the `catalogs` of `pnpm-workspace.yaml`. Every dependency is on
its latest usable version; each exception and its reason is in
[docs/dependency-exceptions.md](./docs/dependency-exceptions.md).
