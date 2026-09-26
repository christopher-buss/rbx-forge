---
status: accepted
---

# Hooks live only in the config file

Hooks are declared in `rbx-forge.config.ts` under `hooks`, keyed by command,
with `pre` and `post` lists of shell commands. forge does not read
`package.json` scripts or mise tasks, and it never writes them. Package-manager
`pre`/`post` scripts as hooks need each step to run as `pnpm run <script>`: that
works only with pnpm's `enable-pre-post-scripts`, adds a pnpm, shell, and node
layer per step, and makes cleanup kill the task runner instead of the real
worker.

## Decisions

- **Keys.** Hooks exist for `build`, `compile`, `open`, `syncback`, and
  `typegen`. Session commands (`start`, `up`) have no hooks of their own; their
  steps run the hooks of those commands.
- **Order.** `pre` hooks run in order; a failure aborts the command. `post`
  hooks run only after the step succeeds; a failed `post` hook fails the
  command. Chained steps run their own hooks: `open` that builds first runs
  `open` `pre`, `build` `pre`, the build, `build` `post`, Studio, then `open`
  `post`.
- **Execution.** Each hook runs through the system shell (`cmd.exe` on Windows,
  `/bin/sh` elsewhere) in the project root, with `node_modules/.bin` first on
  `PATH`. Inside a session, a hook is a worker of the reaper, so it stops with
  the session. `hookTimeoutMs` kills a hook with its whole process tree.
- **Cycle guard.** Each hook inherits `RBX_FORGE_HOOK_STACK` with its id added
  (such as `build:post:0`). A hook already on the stack is skipped (result
  `skipped`); a stack deeper than 8 fails with `hook_depth_exceeded`.
- **Results.** Every result (id, command, outcome, exit code, duration, output
  tail) is in the command's `--json` result, and for syncback in
  `status.services.syncback.lastRun.hooks`.

## Considered options

- **Task-runner hooks next to config hooks.** Two hook systems, and a recursive
  process design. Rejected.
- **Hooks for `start` and `up`.** Rejected: nothing needs them, and the step
  hooks cover the known uses.

## Consequences

- Hooks work the same with pnpm, npm, bun, mise, or no task runner.
