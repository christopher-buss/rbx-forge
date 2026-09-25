# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Project Overview

**rbx-forge** is a CLI for fully-managed Rojo projects (roblox-ts and Luau). It
is being rewritten from scratch under spec
[#28](https://github.com/christopher-buss/rbx-forge/issues/28): supervised
sessions, a native process reaper, config hooks, and `--json` output for agents.
The old implementation is gone; do not restore its commands, config keys, or
task-runner integration.

- **Layout**: one package. `src/` (unit specs next to code), `test/`
  (integration, e2e, fixtures, helpers, setup), `reaper/` (Rust crate). No
  workspace packages.
- **Tools**: pinned in `mise.toml` (Node, hk, pkl, Rust, Rojo). pnpm through
  corepack (`packageManager`).
- **Dependencies**: versions in `pnpm-workspace.yaml` catalogs. Exceptions to
  "latest" are listed in
  [docs/dependency-exceptions.md](docs/dependency-exceptions.md); add one when
  you pin below latest.

## Commands

```bash
pnpm build             # tsdown → dist/cli.mjs
pnpm typecheck         # tsc --build (TypeScript 7 via the @typescript/native alias)
pnpm lint              # isentinel-lint: oxlint, then ESLint
pnpm knip
pnpm test:unit         # 100% coverage threshold
pnpm test:integration  # real processes + fixture binaries
pnpm test:e2e          # needs `pnpm build` first
cargo build --manifest-path reaper/Cargo.toml
```

Before a task is done, lint, typecheck, knip, and every test project must pass.

## Architecture

- `src/cli.ts` is the only module that touches the process (argv, streams,
  `process.exitCode`). Logic lives in modules that take their inputs, so unit
  tests drive them directly (`src/cli/run-cli.ts`).
- Flags come from one table (`src/cli/flags.ts`) parsed with `node:util`
  `parseArgs`; help is generated from it.
- Exit codes live in `src/exit-codes.ts`.
- `bin/rbx-forge.js` imports `dist/cli.mjs`; bins `forge` and `rbx-forge` both
  point at it.

## Testing

- No `vi.mock` (lint enforces it); inject seams.
- Fixture binaries: `test/fixtures/bin/fake-worker.ts` plays rojo, the compiler,
  and hooks. `test/helpers/fixture-bin.ts` writes PATH shims for it. Environment
  variables shape the process tree (grandchildren, detach, ignore signals,
  markers); see the file header.
- `.tmp/` is for scratch projects and is gitignored.

## Commit Conventions

Conventional Commits (see
[.github/commit-instructions.md](.github/commit-instructions.md)); hk's
commit-msg hook checks the format.

## Agent skills

Skills live in `.agents/skills/` (Claude Code reads them through the symlinks in
`.claude/skills/`). Most come from
[mattpocock/skills](https://github.com/mattpocock/skills) and are pinned in
`skills-lock.json`. `create-pr` and `zoom-out` are local skills.

Local edits to upstream skills (re-apply after `npx skills update`):

- `grilling`: top-three rounds, skimmable format, ASD-STE100, `CONTEXT.md`
  vocabulary.
- `handoff`: handoffs into another repository.
- `implement`: autonomous flow (`/simplify`, `/code-review`, frequent commits,
  `/create-pr`).
- `research`: escape `## Sources` brackets for GFM.
- `to-spec`: assign to `@me`; every new module gets tests.
- `to-tickets`: native sub-issue and blocked-by links; assign to `@me`.

### Issue tracker

GitHub Issues for `christopher-buss/rbx-forge` via `gh`. See
`docs/agents/issue-tracker.md`.

### Domain docs

Single-context (`CONTEXT.md` + `docs/adr/` at the root). See
`docs/agents/domain.md`.
