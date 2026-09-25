# rbx-forge

> A roblox-ts and Luau CLI tool for fully-managed Rojo projects

forge runs your Roblox dev loop: compile, build, open Studio, serve Rojo, watch,
and sync Studio edits back. It owns every process it starts: when the session
stops, however it stops, every process stops with it. Every command has `--json`
output, so an AI agent can drive it.

## Requirements

- Node.js 24.12 or later.
- Windows 10 1607 / Server 2016 or later, Linux (glibc or musl), or macOS; x64
  or arm64. forge installs a prebuilt native package for your platform
  (`@rbx-forge/native-<platform>`); a platform without one gets
  `native_missing`.
- [Rojo](https://rojo.space) on `PATH` or as a project dependency. Syncback
  needs Rojo 7.7 or later.
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
| `forge down`        | Close the session's Studio, then stop the session. Reports `stopped` only when its supervisor and every process of it are gone.           |

`start` and `up` take the same flags:

- `--no-compiler`: no compile, no build, no watch-mode compiler: only Rojo and
  Studio. The open step still builds when `open.buildFirst` is on.
- `--no-open`: do not open Studio. By default the session opens the place and
  ends when Studio closes it.
- `--syncback`: run syncback and its hooks each time the place file is saved
  (config `syncback.runOnStart`).
- `--force`: when a crashed earlier session still has processes after the wait,
  kill them, each verified as that session's own.
- `--studio-path <path>`: the Roblox Studio executable to start (see
  [Opening Studio](#opening-studio)).

`down` takes `--timeout <seconds>` (default 15), `--force` (kill a supervisor
that does not stop, and what is left of its session, each verified),
`--keep-studio` (leave the session's Studio open), and `--recovery <mode>` (see
[Auto-recovery](#auto-recovery)).

### Opening Studio

`open`, `start`, and `up` start the Studio executable directly, with the place
as its only argument, as a double-click on the place does. Studio runs outside
every process group and job of forge, so it outlives forge. forge pins the
process at the start (PID and start time) and the session records both. forge
finds the executable in this order:

1. `--studio-path <path>` (`open`, `start`, `up`).
2. The `RBX_FORGE_STUDIO_PATH` environment variable (empty means unset).
3. Windows: the command that opens `roblox-studio:` links
   (`HKCU\Software\Classes\roblox-studio\shell\open\command`), then the command
   that opens `.rbxl` files (`HKCU\Software\Classes\Roblox.Place`).
4. macOS: `/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio`.

A path from 1 or 2 that is not a file fails with `studio_launch_failed`. When
forge finds no executable, or the terminal's job forbids breakaway (Windows), it
opens the place through the platform launcher (`start`, `open`, `xdg-open`), and
the session knows Studio only by the place's lock file.

### Closing Studio

`down` and `stop` close Studio the same way. forge sends a close request, as
when you close its window (`WM_CLOSE` to its main windows; `SIGTERM` on macOS
and Linux), then looks at Studio every 50 ms:

- When the place's lock file goes, Studio has closed the place: forge ends the
  process at once, instead of waiting for Studio's slow exit.
- When a modal dialog blocks Studio (Windows), forge ends it at once, without a
  save. A place fresh from `rojo build` always counts as changed in Studio, so
  "Save changes?" is the common case. Studio also shows a modal dialog while it
  opens a place.
- When Studio is still open after 15 seconds, forge ends it without a save.

After it ends Studio, forge deletes the place's lock file, which an ended Studio
cannot delete. Which Studio: the one the session started, when it still runs
with its recorded start time; the lock file, when there is one, must name the
same process. Else the Studio the place's lock file names, after forge verifies
that the process is that Studio (this computer, the Studio executable, started
before the lock file). It never touches another Studio.

`stop` asks the running session for its Studio, and falls back to the lock file
of the configured place. When the session reports Studio as `opening` (started,
the place not open yet), `stop` and `down` wait up to 60 seconds for it to be
`open`, then close it. When `down` closes Studio, the session ends by itself
once a syncback run for a last save is done. `--force` does not change how
Studio closes.

### Auto-recovery

Studio deletes its auto-recovery files only when it closes the place by itself.
After forge ends a Studio it verified with the place still open (a dialog, the
time limit, or no window: `forced`), it handles that Studio's auto-recovery
files, so the next launch does not offer to recover a place forge builds anyway:

- `move` (the default): move them to `.forge/recovery/<time>_<file>`, and keep
  the 5 newest there. They are normal place files: open one in Studio to get
  back changes made in Studio.
- `delete`: delete them.
- `keep`: leave them.

Set the mode with `studio.autoRecovery` in the config, or `--recovery <mode>` on
`stop` and `down`. forge acts only when it forced a Studio, and only on
`<place>_AutoRecovery_<n>.rbxl` files (any case) for the place, written since
that Studio started (2 seconds of slack). It searches:

- Windows: `%LOCALAPPDATA%\Roblox\RobloxStudio\AutoSaves` and
  `%USERPROFILE%\Documents\ROBLOX\AutoSaves`.
- macOS: `~/Library/Application Support/Roblox/RobloxStudio/AutoSaves` and
  `~/Documents/ROBLOX/AutoSaves`.

forge tries a busy file again for 5 seconds (Windows can hold the file of a
killed process), and copies and deletes a file on another drive. A failure is a
warning in `recovery.warnings`; it never fails `stop` or `down`. Limit: two
projects with the same place file name, open at the same time, can match each
other's file. `move` keeps the file, so nothing is lost.

One-shot commands:

| Command          | What it does                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| `forge init`     | Create `rbx-forge.config.ts`. `--type <rbxts\|luau>`, `--force` to replace.                              |
| `forge config`   | Print the resolved config.                                                                               |
| `forge build`    | Build the Rojo project. `-o, --output <path>`, or `--plugin <name>` for Studio's plugins folder.         |
| `forge compile`  | Compile roblox-ts once and report errors (rbxts only).                                                   |
| `forge open`     | Open the place in Studio. `--place <path>`, `--build` / `--no-build`, `--studio-path <path>`.            |
| `forge stop`     | Close the Studio of the session or of this project's place, after it verifies it. `--recovery <mode>`.   |
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
   `data.services.studio` has `status` (`opening`, `open`, `closed`, `off`),
   `place`, and, for a Studio forge started, `pid` and `startTime`.
4. Play and read the console with the Roblox Studio MCP.
5. `forge sync --json`: pull Studio edits into the project, with the syncback
   hooks. It waits for a running save-triggered run, then runs once more.
   Failures keep their code, with hook results in `error.details.hooks`.
6. `forge down --json`: `data.stoppedBy` is `shutdown`, `forced_shutdown`,
   `killed`, `gone`, or `studio_closed` (the session ended by itself once `down`
   closed its Studio). `data.studio.status` is `closed`, `kept`
   (`--keep-studio`), `none` (no Studio open), `unknown` (the supervisor did not
   answer, so forge touched no Studio), or `failed` (with the error's `code` and
   `message`: Studio may still be open; the session still stops). A `closed`
   Studio has `end`: `exited`, `lock_released` (closed the place, then forge
   ended the process), `dialog`, `timeout`, or `no_window`; `forced: true` when
   forge ended it without a save; and `recovery` (`null` unless `forced`, or
   `mode`, `moved` (`from`, `to`), `deleted`, `warnings`). `forge stop` reports
   the same fields in `data`, with `stopped`. Exit 6 means processes still live
   or the supervisor does not answer: retry with `--force`. Exit 5 means forge
   could not verify a process, so it killed nothing.

`forge logs <name> --json` gives one `log` event per line.

## Development

Tools are pinned in `mise.toml`: `mise install`, then `pnpm install`.

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

Git hooks: `hk install --global --mise`. See
[CONTRIBUTING.md](./CONTRIBUTING.md) and [AGENTS.md](./AGENTS.md).

## License

[MIT](./LICENSE)
