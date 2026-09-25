# rbx-forge

> A roblox-ts and Luau CLI tool for fully-managed Rojo projects

forge runs your Roblox dev loop: compile, build, open Studio, serve Rojo, watch,
and sync Studio edits back. It owns every process it starts: when the session
stops, however it stops, every process stops with it. Every command has `--json`
output, so an AI agent can drive it.

**Pre-release.** This is the rewrite for the next major version
([#28](https://github.com/christopher-buss/rbx-forge/issues/28)). It is not
released yet. The last release of the old design is `1.0.0-beta.10`, and nothing
of the old commands, config keys, or task-runner scripts carries over.

## Requirements

- Node.js 24.12 or later.
- Windows 10 1607 / Server 2016 or later, Linux (glibc or musl), or macOS; x64
  or arm64. forge installs a prebuilt native package for your platform
  (`@rbx-forge/native-<platform>`); a platform without one gets
  `native_missing`.
- [Rojo](https://rojo.space) on `PATH` or as a project dependency. Syncback
  needs the [UpliftGames Rojo fork](https://github.com/UpliftGames/rojo).
- For roblox-ts projects: `roblox-ts` as a project dependency.

## Quick start

```bash
npm install --save-dev rbx-forge
npx forge init --type rbxts   # writes rbx-forge.config.ts, and nothing else
npx forge start               # compile, build, open Studio, serve Rojo, watch
```

Add `.forge/` to your `.gitignore`. forge keeps its session files and logs
there.

The bins `forge` and `rbx-forge` are the same. Run forge from the project root.

## Commands

Session commands:

| Command             | What it does                                                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `forge start`       | Run the session in this terminal. Ctrl+C, a closed terminal, or a killed `start` stops every process of the session.                      |
| `forge up`          | Start the same session in the background. Returns when Rojo listens and the first compile is done. Reports a running session if one runs. |
| `forge status`      | Each service's state, the Rojo port, the last compile with its diagnostics, and the last syncback run with its hooks.                     |
| `forge sync`        | Run syncback and its hooks through the running session, and report the result.                                                            |
| `forge logs <name>` | Print a full log: `compile`, `compiler`, `rojo`, `start`, `supervisor`, or `syncback`. `-f`/`--follow` keeps printing new lines.          |
| `forge down`        | Stop the running session. Reports `stopped` only when its supervisor and every process of it are gone.                                    |

`start` and `up` take the same flags:

- `--no-compiler`: no compile, no build, no watch-mode compiler: only Rojo and
  Studio. The open step still builds when `open.buildFirst` is on.
- `--no-open`: do not open Studio. By default the session opens the place and
  ends when Studio closes it.
- `--syncback`: run syncback and its hooks each time the place file is saved
  (config `syncback.runOnStart`).
- `--force`: when a crashed earlier session still has processes after the wait,
  kill them, each verified as that session's own.

`down` takes `--timeout <seconds>` (default 15) and `--force` (kill a supervisor
that does not stop, and what is left of its session, each verified).

One-shot commands:

| Command          | What it does                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| `forge init`     | Create `rbx-forge.config.ts`. `--type <rbxts\|luau>`, `--force` to replace.                              |
| `forge config`   | Print the resolved config.                                                                               |
| `forge build`    | Build the Rojo project. `-o, --output <path>`, or `--plugin <name>` for Studio's plugins folder.         |
| `forge compile`  | Compile roblox-ts once and report errors (rbxts only).                                                   |
| `forge open`     | Open the place in Studio. `--place <path>`, `--build` / `--no-build`.                                    |
| `forge stop`     | Close the Studio that has this project's place open, after it verifies the process is Studio.            |
| `forge syncback` | Sync the place back into the project once. `--input <path>`, `--project <path>`.                         |
| `forge typegen`  | Write service types from the Rojo sourcemap. `-o`, `--include`, `--exclude`, `--max-depth` (rbxts only). |

`forge --help` and `forge <command> --help` show every flag.

One session runs per project (per worktree and build output). A second `start`
fails with `session_running`; a second `up` joins the running session. A new
session waits until every process of a crashed old one is gone.

## Configuration

See [docs/config.md](./docs/config.md) for every option, and for hooks: shell
commands that run before or after `build`, `compile`, `open`, `syncback`, and
`typegen`, declared in the config file.

```ts
import { defineConfig } from "rbx-forge";

export default defineConfig({
	hooks: {
		syncback: { post: ["pnpm eslint --fix src"] },
	},
	projectType: "rbxts",
	rojoPort: 34872,
	syncback: { runOnStart: true },
});
```

## Output and exit codes

With `--json`, or when stdout is not a terminal, forge writes NDJSON: one event
per line (`step`, `info`, `warning`, `compiled`, `log`), then one final line:

```text
{"type":"result","command":"status","ok":true,"data":{...}}
{"type":"result","command":"down","ok":false,"exitCode":6,"error":{"code":"cleanup_in_progress","message":"...","hint":"...","details":{...}}}
```

A run that cannot prompt (not a terminal, `--json`, or `CI`) never prompts: it
takes a safe default or fails with `needs_confirmation`.

| Exit | Meaning                                                 | Error codes                                                                   |
| ---- | ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 0    | success                                                 |                                                                               |
| 1    | failure (config, tool, hook, or declined prompt)        | every code not listed below                                                   |
| 2    | unreadable command line                                 | `usage`                                                                       |
| 3    | no session is running                                   | `not_running`, `session_replaced`                                             |
| 4    | needs confirmation, and the run cannot prompt           | `needs_confirmation`                                                          |
| 5    | cannot verify a process identity; nothing was killed    | `identity_mismatch`, `cleanup_unverifiable`                                   |
| 6    | cleanup in progress, or the supervisor does not respond | `cleanup_in_progress`, `previous_generation_alive`, `supervisor_unresponsive` |
| 130  | interrupted                                             | `interrupted`                                                                 |

Error codes are stable: a code is never renamed or reused. The full list is in
[`src/errors.ts`](./src/errors.ts).

## For agents

The intended flow:

1. `forge up --json`: start the session, or find the running one
   (`data.started`). Returns when Rojo listens and the first compile is done.
2. Edit code.
3. `forge status --json`: `data.services.compiler.lastBuild` has `errors` and
   `diagnostics` (`file`, `line`, `column`, `code`, `message`, `severity`).
4. Play and read the console with the Roblox Studio MCP.
5. `forge sync --json`: pull Studio edits into the project, with the syncback
   hooks. It waits for a running save-triggered run, then runs once more.
   Failures keep their code, with hook results in `error.details.hooks`.
6. `forge down --json`: `data.stoppedBy` is `shutdown`, `forced_shutdown`,
   `killed`, or `gone`. Exit 6 means processes still live or the supervisor does
   not answer: retry with `--force`. Exit 5 means forge could not verify a
   process, so it killed nothing.

`forge logs <name> --json` gives one `log` event per line.

## Development

Tools are pinned in `mise.toml`: `mise install`, then `pnpm install`.

| Script                        | What it runs                                      |
| ----------------------------- | ------------------------------------------------- |
| `pnpm build`                  | tsdown bundle of the CLI into `dist/`             |
| `pnpm typecheck`              | `tsc --build` with TypeScript 7                   |
| `pnpm lint` / `pnpm lint:fix` | oxlint, then ESLint (`isentinel-lint`)            |
| `pnpm knip`                   | unused files, exports, and dependencies           |
| `pnpm test:unit`              | unit project with 100% coverage                   |
| `pnpm test:integration`       | real processes and the addon (run `build:native`) |
| `pnpm test:e2e`               | the built CLI as a subprocess (run `build` first) |
| `pnpm build:native`           | the Rust crate in `reaper/` through napi-rs       |
| `pnpm mutation`               | Stryker mutation testing                          |

Git hooks: `mise run install-hk`. See [CONTRIBUTING.md](./CONTRIBUTING.md) and
[AGENTS.md](./AGENTS.md).

## License

[MIT](./LICENSE)
