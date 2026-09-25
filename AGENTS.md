## Why the code is this way

Read the comment at the line, then walk the line's history:
`git log -n 3 -L<n>,<n>:<file> -s --format='%h %s'` lists the last commits that
touched line `n`, across renames. Rationale lives in those two places.

A comment states an invariant, in a line or two. Most code does not need further
explanation. The commit tells the story: what failed, what was measured, what
the line replaced.

A collateral change tempts the longest comment, because that comment argues for
the edit. Put the argument in the commit; the line keeps its invariant. Long
blocks already in the file are sediment, not a standard to match.

## Living documents

All project docs (`AGENTS.md`, `CONTEXT.md`, ADRs) are read cold and edited in
place. Write in present tense; no amendments or change-history sections. Keep it
tight.

An ADR records the decision, not its tunables. Caps and thresholds change
without the architecture changing, so an ADR naming them needs amending on every
tuning pass; where they must appear, Consequences is the place to call them a
tuning surface.

When changing public-facing behavior, check README.md to see if the
documentation needs updating.

## Agent skills

### Issue tracker

GitHub Issues via `gh`; see `docs/agents/issue-tracker.md`.

### Triage labels

Mapped to Linear workflow states (`Triage`, `Todo`, `Canceled`) plus three
labels (`NeedsInfo`, `Agent`, `PRD`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: CONTEXT.md + docs/adr/ at the repo root (created lazily). See
docs/agents/domain.md.

### Git and PRs

## Commits

Conventional Commits
([.github/commit-instructions.md](.github/commit-instructions.md)); hk's
commit-msg hook checks the format. Merge commits too (`chore: merge ...`).

## Commands

```bash
pnpm build             # tsdown → dist/{cli,supervisor,index}.mjs
pnpm build:native      # napi addon + forge-reaper into reaper/target/napi
pnpm typecheck         # tsc --build (TypeScript 7 via the @typescript/native alias)
pnpm lint              # isentinel-lint: oxlint, then ESLint (also Markdown, cspell)
pnpm knip
pnpm test:unit         # 100% coverage threshold
pnpm test:integration  # needs build:native
pnpm test:e2e          # needs build and build:native
pnpm mutation          # Stryker; the floor only moves up
cargo test --manifest-path reaper/Cargo.toml
```

A fresh worktree needs `pnpm build:native` before integration or e2e tests.
`pnpm test:other-user` runs only in the CI job that creates a second local user.
Before a task is done, lint, typecheck, knip, and every test project must pass.

## Test levels

- **Unit** (`src/**/*.spec.ts`): through a use-case with injected seams
  (`createTestSeams`, `test/helpers/seams.ts`; memfs for files). Never spawns a
  process. `src/cli.ts` and `src/supervisor.ts` are excluded.
- **Integration** (`test/integration/`): the supervisor, reaper, addon, locks,
  and IPC through their Node APIs, with real processes. `session-harness.ts`
  builds projects and stages old sessions.
- **E2E** (`test/e2e/`): the built CLI as a subprocess in a temp fixture
  project. Assert only NDJSON, exit codes, files, and the process table.
- **Fixtures**: `test/fixtures/bin/fake-worker.ts` plays rojo, the compiler, and
  hooks; its header lists the environment variables that shape its process tree.
  `test/helpers/fixture-project.ts` makes e2e projects.
- **Pause points** make races reproducible: `RBX_FORGE_TEST_PAUSE_DIR` plus
  `RBX_FORGE_TEST_PAUSE=<points>`, read only in `src/supervisor.ts` and the
  reaper. A paused process writes `<dir>/<point>.paused`; the test deletes it to
  go on.
- Rules: `vi.mock` is banned (lint); inject seams. No lifecycle hooks in specs:
  factories plus `onTestFinished`. `assert`, no `if`, in specs.

## Seams

- `src/cli.ts` and `src/supervisor.ts` are the only modules that touch the
  process (argv, `process.env`, streams, exit). They build the real `Seams`
  record (`src/seams/node-seams.ts`); every other module takes it as a required
  argument.
- A new I/O dependency is a new member of `Seams` (`src/seams/seams.ts`), with a
  real implementation and a fake in `test/helpers/`.
- Commands: `src/commands/` (one `run*Async` each), registered with their flag
  tables in `src/cli/commands.ts`. Help comes from the same tables. Flags set no
  defaults: `src/config/resolve.ts` applies flags > file > defaults.
- A new config option goes in `src/config/schema.ts` (type and arktype schema),
  `DEFAULT_CONFIG` in `resolve.ts`, the type exports of `src/index.ts`, and
  `docs/config.md`.
- Errors: throw `ForgeError` with a code from `src/errors.ts`; each code has one
  exit code from `src/exit-codes.ts`. Codes appear in `--json` output: never
  rename or reuse one. Invariants use `assert`.
- Native: `reaper/` builds the `forge-reaper` binary and the addon.
  `src/native/addon.ts` is its TypeScript surface, written by hand: change it
  with `reaper/src/lib.rs`.

## Windows rules

- Every child process gets `windowsHide: true`.
- Node-based tools run as their JS entry with the current Node, never through a
  `node_modules/.bin` shim (`src/process/resolve-tool.ts`). A `.cmd` from `PATH`
  runs through `cmd.exe` with its arguments escaped twice.
- libuv puts a non-detached child in a `KILL_ON_JOB_CLOSE` job: the supervisor
  is spawned detached on every OS, and `up` needs job breakaway (ADR 0001).
- IPC clients connect through the addon (`connectPipe`), not `node:net`, which
  waits 30 s per busy pipe.
- Environment variable names are case-insensitive: read and set them through
  `src/process/environment.ts`.
- An e2e test that opens a place must use the Studio stand-in (a `.cmd`); a
  plain `.rbxl` opens real Studio.
