<h1 align="center">rbx-forge</h1>

<div align="center">

[![npm](https://raw.githubusercontent.com/maneetoo/Roblox-OSS-Badges/5959dc76990e4dc70d697f8b39db48da5a282837/Badges/Community/Package/link-npm.svg)](https://npmx.dev/package/rbx-forge)
[![Sponsor me](https://raw.githubusercontent.com/maneetoo/Roblox-OSS-Badges/b880ff3b8ca27e95914b12adcb784e29ef5c7222/Badges/Roblox-Styled/Original/sponsor-me-var2.svg)](https://github.com/sponsors/christopher-buss)

[![CI](https://github.com/christopher-buss/rbx-forge/actions/workflows/ci.yaml/badge.svg)](https://github.com/christopher-buss/rbx-forge/actions/workflows/ci.yaml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

</div>

forge runs the dev loop of a roblox-ts or Luau Rojo project: compile, build,
open Studio, serve Rojo, watch, and sync Studio edits back. It owns every
process it starts, so when the session stops, however it stops, every process
stops with it. Every command has `--json` output, so an AI agent can drive it.

## What forge does

One command, `forge start`, compiles the project, builds the place, opens it in
Studio, serves Rojo, and starts the watch-mode compiler. With syncback on, each
save in Studio syncs the place back into the project and runs your hooks, such
as `eslint --fix`.

A session runs in its own supervisor process. A native reaper process starts
every worker (Rojo, the compiler, syncback, hooks) and owns it at OS level.
Ctrl+C, a closed terminal, or a killed `forge start` stops every worker.

`forge down` closes the session's Studio too. forge ends Studio when a "Save
changes?" dialog blocks it, and moves the auto-recovery files out of Studio's
AutoSaves folder, so the next launch does not offer to recover a place forge
builds anyway. forge closes only a Studio that it can verify, never another one.
See [docs/studio.md](./docs/studio.md).

forge is a fork of [rbxts-build](https://github.com/roblox-ts/rbxts-build) by
osyrisrblx, rewritten.

## Install

Requirements:

- Node.js 24.12 or later.
- Windows 10 1607 / Server 2016 or later, Linux (glibc or musl), or macOS; x64
  or arm64. forge installs a prebuilt native package for your platform
  (`@rbx-forge/native-<platform>`); a platform without one gets
  `native_missing`.
- [Rojo](https://rojo.space) on `PATH` or as a project dependency. Syncback
  needs Rojo 7.7 or later.
- For roblox-ts projects: `roblox-ts` as a project dependency, or
  [sloptor](https://github.com/howmanyslop/sloptor) with
  `rbxts: { args: ["build", "--json"], command: "sloptor" }` in the config (see
  [`rbxts.command`](./docs/config.md#rbxtscommand)).

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

| Command             | What it does                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `forge start`       | Run the session in this terminal. Ctrl+C, a closed terminal, or a killed `start` stops every process of the session.                                                                                                           |
| `forge up`          | Start a session in the background with the watch-mode compiler. Returns when its first compile is done, or it failed. `--studio` also attaches Studio and Rojo. On a running session, starts only the missing or failed parts. |
| `forge status`      | Each part's state and owner, the Rojo port, the last compile with its diagnostics, and the last syncback run with its hooks. `--wait`: see below.                                                                              |
| `forge sync`        | Run syncback and its hooks through the running session, and report the result.                                                                                                                                                 |
| `forge logs <name>` | Print a full log: `compile`, `compiler`, `rojo`, `start`, `supervisor`, or `syncback`. `-f`/`--follow` keeps printing new lines.                                                                                               |
| `forge down`        | Stop the session's parts that have no owner (Studio first), and end the session when none is left. Reports `stopped` only when its supervisor and every process of it are gone.                                                |

`start` runs the compiler, Rojo, and Studio. Its flags:

- `--no-compiler`: no compile, no build, no watch-mode compiler: only Rojo and
  Studio. The open step still builds when `open.buildFirst` is on.
- `--no-open`: do not open Studio. By default the session opens the place and
  ends when Studio closes it.
- `--syncback`: run syncback and its hooks each time the place file is saved
  (config `syncback.runOnStart`).
- `--force`: when a crashed earlier session still has processes after the wait,
  kill them, each verified as that session's own.
- `--studio-path <path>`: the Roblox Studio executable to start (see
  [Opening Studio](./docs/studio.md#opening-studio)).

`up` starts the watch-mode compiler, which does the first compile. A project
with no compiler (Luau with no `luau.watch.command`) gets a session with no
part. `up` takes `--syncback`, `--force`, and `--no-compiler` (start no part).
On a running session, `up` starts the parts it asks for that are missing or
failed, such as a compiler that crashed, or the Rojo of an attached Studio, and
names them in `data.added`; it never stops or restarts a part that runs.

`up --studio` also attaches Studio and Rojo, once the compiler's build is fresh:
it uses the Studio that has the place open (verified as `stop` does), or builds
the place and opens it (`--studio-path <path>` names the executable). Rojo
serves on the session's port (see [`rojoPort`](./docs/config.md#rojoport)). It
returns when Rojo listens and Studio has the place open. When that Studio closes
the place, only its Rojo stops; the compiler runs on.

`down` acts only on parts with no owner. A part that a `forge start` terminal
owns keeps running, and so does the session: `down` names it in
`data.parts.kept` and still succeeds. `down` takes `--timeout <seconds>`
(default 15), `--force` (kill a supervisor that does not stop, and what is left
of its session, each verified), `--keep-studio` (leave the session's Studio
open), and `--recovery <mode>` (see
[Auto-recovery](./docs/studio.md#auto-recovery)).

`status --wait` returns the status once the compiler's last build is fresh: no
compile runs, and none started for a short quiet window. Run it after an edit.
`--timeout <seconds>` bounds the wait (default 300), else it fails with
`compile_timeout`. `--timeout 0` does not wait: it returns the status now. With
no roblox-ts compiler in the session, it returns at once.

One session runs per project (per worktree and build output). A second `start`
fails with `session_running`; a second `up` joins the running session and adds
its missing parts. A new session waits until every process of a crashed old one
is gone. After 30 minutes with no activity (a command that talks to the session,
a compile start, or a Studio save), a session stops its parts with no owner, as
`down` does; set it with `session.idleTimeout`.

One-shot commands:

| Command          | What it does                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `forge init`     | Create `rbx-forge.config.ts`. `--type <rbxts\|luau>`, `--force` to replace.                               |
| `forge config`   | Print the resolved config.                                                                                |
| `forge build`    | Build the Rojo project. `-o, --output <path>`, or `--plugin <name>` for Studio's plugins folder.          |
| `forge compile`  | Compile roblox-ts once and report errors (rbxts only). While a session runs: see below.                   |
| `forge open`     | Open the place in Studio. `--place <path>`, `--build` / `--no-build`, `--studio-path <path>`.             |
| `forge stop`     | Close the session's Studio (and stop its Rojo) or the Studio of a place, after it verifies it. See below. |
| `forge syncback` | Sync the place back into the project once. `--input <path>`, `--project <path>`.                          |
| `forge typegen`  | Write service types from the Rojo sourcemap. `-o`, `--include`, `--exclude`, `--max-depth` (rbxts only).  |

`stop` closes the session's Studio and stops its Rojo; the compiler keeps
running, and an `up` session with no part left ends. A Studio that a
`forge start` terminal owns fails with `studio_owned` (exit 1); `--force` closes
it too. With no session Studio, `stop` closes the Studio that the place's lock
file names. `--place <path>` selects the place, and `--recovery <mode>` handles
the auto-recovery files.

While a session runs, `forge compile` starts no second compiler: it waits for
the session's fresh build (as `status --wait`), with its `compile` hooks around
the wait, and reports that build in the same result. A session with its compiler
off or stopped fails with `compiler_off`; run `forge up` to start it.

`forge --help` and `forge <command> --help` show every flag.

## Configuration

forge reads `rbx-forge.config.ts` from the project root. Hooks are shell
commands that run before or after `build`, `compile`, `open`, `syncback`, and
`typegen`:

```ts
import { defineConfig } from "rbx-forge";

export default defineConfig({
	hooks: {
		syncback: { post: ["pnpm eslint --fix src"] },
	},
	projectType: "rbxts",
	syncback: { runOnStart: true },
});
```

See [docs/config.md](./docs/config.md) for every option.

## For agents

With `--json`, or when stdout is not a terminal, forge writes NDJSON and ends
with one `result` line. A run that cannot prompt never prompts. Error codes are
stable, and each maps to one exit code. The loop:

1. `forge up --json` starts the compiler in a background session. On a running
   session, it starts the compiler again if it failed.
2. Edit code.
3. `forge status --json --wait` gives the compile errors with file, line, and
   column. `--wait` waits for the compile of your edit, so the result is never
   the build before it.
4. To play, `forge up --studio --json` attaches Studio and Rojo to the session;
   read the console with the Roblox Studio MCP. For a one-time look,
   `forge open --json` opens the place. `forge stop --json` closes Studio and
   its Rojo; the compiler runs on.
5. `forge sync --json` pulls Studio edits into the project.
6. `forge down --json` stops the parts with no owner, and the session once none
   is left. It never fails because a `forge start` terminal owns a part. A
   forgotten session stops the same way after `session.idleTimeout` minutes (30
   by default) with no activity.

See [docs/json-output.md](./docs/json-output.md) for the result fields and exit
codes.

## Contributing

Tools are pinned in `mise.toml`: `mise install`, then `pnpm install`. Read
[CONTRIBUTING.md](./CONTRIBUTING.md) for the scripts and checks, and
[AGENTS.md](./AGENTS.md) for the code layout and test rules.

## License

[MIT](./LICENSE) (c) Christopher Buss. Portions (c) osyrisrblx, from
rbxts-build.
