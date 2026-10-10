<h1 align="center">rbx-forge</h1>

<div align="center">

[![npm](https://raw.githubusercontent.com/maneetoo/Roblox-OSS-Badges/5959dc76990e4dc70d697f8b39db48da5a282837/Badges/Community/Package/link-npm.svg)](https://npmx.dev/package/rbx-forge)
[![Sponsor me](https://raw.githubusercontent.com/maneetoo/Roblox-OSS-Badges/b880ff3b8ca27e95914b12adcb784e29ef5c7222/Badges/Roblox-Styled/Original/sponsor-me-var2.svg)](https://github.com/sponsors/christopher-buss)

[![CI](https://github.com/christopher-buss/rbx-forge/actions/workflows/ci.yaml/badge.svg)](https://github.com/christopher-buss/rbx-forge/actions/workflows/ci.yaml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

</div>

forge runs the dev loop of a roblox-ts or Luau Rojo project: compile, build,
serve Rojo, open Studio, watch, and sync Studio edits back. It owns every
process it starts, so when the session stops, however it stops, every process
stops with it. Every command has `--json` output, so an AI agent can drive it.

## What forge does

One command, `forge start`, compiles the project, builds the place, serves Rojo,
and starts the watch-mode compiler. It opens Studio only once Rojo listens. With
syncback on, each save in Studio syncs the place back into the project and runs
your hooks, such as `eslint --fix`.

A Studio launched for a session connects to its own worktree's Rojo and
reconnects after a same-port restart. It refuses another worktree's project;
click Disconnect in the Rojo widget to stop reconnecting. See
[Studio sync](./docs/studio.md#managed-rojo-plugin) for supported plugins and
readiness behavior.

A session runs in its own supervisor process. A native reaper process starts
every worker (Rojo, the compiler, syncback, hooks) and owns it at OS level.
Ctrl+C, a closed terminal, or a killed `forge start` stops every worker that
`start` started. Studio stays open.

`forge down` closes the session's Studio too. forge ends Studio when a "Save
changes?" dialog blocks it, and moves the auto-recovery files out of Studio's
AutoSaves folder, so the next launch does not offer to recover a place forge
builds anyway. forge closes only a Studio that it can verify, never another one.
See [docs/studio.md](./docs/studio.md).

forge is a fork of [rbxts-build](https://github.com/osyrisrblx/rbxts-build) by
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
- For roblox-ts projects: `roblox-ts` as a project dependency (see
  [`rbxts.command`](./docs/config.md#rbxtscommand)).
- On Windows, to run `forge up` through pnpm (`pnpm exec`, `pnpm run`): pnpm 11
  or earlier, or 12.10 or later. pnpm 12.0 to 12.9 runs scripts in a job that
  `up` cannot leave, so `up` fails with `detach_unsupported`.

```bash
npm install --save-dev rbx-forge
npx forge init --type rbxts   # writes rbx-forge.config.ts, and nothing else
npx forge start               # compile, build, serve Rojo, watch, open Studio
```

Add `.forge/` to your `.gitignore`. forge keeps its session files and logs
there.

The bins `forge` and `rbx-forge` are the same. Run forge from the project root.

## Commands

Session commands:

| Command                     | What it does                                                                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `forge start`               | Run the session in this terminal, or join the running one, as the owner of its parts. Ctrl+C, a closed terminal, or a killed `start` stops the parts it started and gives back the rest. Studio stays open.                    |
| `forge up`                  | Start a session in the background with the watch-mode compiler. Returns when its first compile is done, or it failed. `--studio` also attaches Studio and Rojo. On a running session, starts only the missing or failed parts. |
| `forge status`              | Each part's state and owner, the Rojo port, the last compile with its diagnostics, and the last syncback run with its hooks. `--wait`: see below.                                                                              |
| `forge save`                | Save the session Studio to disk before syncback. `--place <snapshot>` saves a snapshot Studio. `--timeout <s>` controls the wait.                                                                                              |
| `forge show` / `forge hide` | Show or hide the same session Studio in place without saving or running syncback. Keeps its PID, undo history, script tabs, Rojo, and ownership.                                                                               |
| `forge sync`                | Run syncback and its hooks through the running session, and report the result.                                                                                                                                                 |
| `forge logs <name>`         | Print a full log: `compile`, `compiler`, `rojo`, `start`, `supervisor`, or `syncback`. `-f`/`--follow` keeps printing new lines.                                                                                               |
| `forge restart`             | Restart the session's parts that have no owner: the compiler, then a fresh Studio with Rojo on the same port. See below.                                                                                                       |
| `forge down`                | Stop the session's parts that have no owner (Studio first), and end the session when none is left. Reports `stopped` only when its supervisor and every process of it are gone.                                                |

`start` runs the compiler, Rojo, and Studio, and owns them: `down`, `stop`,
`restart`, and the idle timeout leave them alone. When a session runs (such as
an agent's `up`), `start` joins it instead: it takes every running part (with
`--no-open`, only the compiler), without a restart, and starts the missing ones.
On Ctrl+C (or a closed terminal) it stops the parts it started and gives back
the parts it took, which run on with no owner; the session ends when no part is
left. It never closes Studio, and the close of its Studio stops nothing. Its
flags:

- `--no-compiler`: no compile, no build, no watch-mode compiler: only Rojo and
  Studio. The open step still builds when `open.buildFirst` is on.
- `--no-open`: no Studio and no Rojo (Rojo runs only with Studio): only the
  compiler. A `start` that joins takes and adds only the compiler; a Studio and
  Rojo that run stay with no owner.
- `--syncback`: run syncback and its hooks each time the place file is saved
  (config `syncback.runOnStart`).
- `--force`: when a crashed earlier session still has processes after the wait,
  kill them, each verified as that session's own.
- `--desktop <user|hidden>`: where Studio opens on Windows and macOS. `start`
  and `open` default to `user`; `up --studio` defaults to `hidden`. On Windows,
  a hidden session Studio runs on the user's desktop with hidden windows; a
  hidden snapshot uses a separate desktop. Each save of a hidden session Studio
  briefly shows the File menu and moves keyboard focus. See
  [Hidden desktop](./docs/studio.md#hidden-desktop).
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
serves on the session's port (see [`rojoPort`](./docs/config.md#rojoport)) and
must listen before forge launches a new Studio. If Rojo fails to listen, forge
reports its failure and launches no Studio. A direct session launch runs a
marker script identifying that Rojo; see
[Opening Studio](./docs/studio.md#opening-studio). With the managed plugin, it
returns once Studio opens the place, completes its initial sync, and opens the
sync stream. Existing Studios and unsupported plugins need manual connection;
their open status confirms only the place lock. When Studio closes the place,
only its Rojo stops; the compiler runs on.

Before a new direct session launch, forge prepares the managed Rojo plugin by
default. Rojo 7.7.0 and 7.7.1 share the supported stock sources; other versions
are preserved when their sources are unrecognized, with a warning that names the
plugin and server Rojo versions or reports hand edits. Restore the stock plugin
with the project's `rojo plugin install`, then restart Studio. See
[Managed Rojo plugin](./docs/studio.md#managed-rojo-plugin).

A Studio that already had the place open when the session attached it is a found
Studio (`origin: "found"` in `status`; a Studio the session opened is `forge`).
Only `stop --force` and `restart --force` close it during cleanup. Explicit
`show` and `hide` change its visibility in place, keeping its owner and origin
without saving. `down` and the idle timeout stop its Rojo and leave it open,
`restart` keeps it, and `stop` fails with `studio_found` (exit 1).

`down` acts only on parts with no owner. A part that a `forge start` terminal
owns keeps running, and so does the session: `down` names it in
`data.parts.kept` and still succeeds. A found Studio stays open, also with
`--force`: `down` reports Studio `kept`, with `found: true`. `down` takes
`--timeout <seconds>` (default 15), `--force` (kill a supervisor that does not
stop, and what is left of its session, each verified), `--keep-studio` (leave
the session's Studio open), and `--recovery <mode>` (see
[Auto-recovery](./docs/studio.md#auto-recovery)).

`restart` restarts every part with no owner. It closes Studio without a save (as
`stop` does; a Studio it cannot close fails it before any part stops), stops
Rojo and the compiler, and waits until the reaper reports each old process tree
gone; when one is not, it fails with `cleanup_in_progress` and starts nothing.
Then it starts the compiler and, once its first build is done, builds the place,
opens it in a new Studio, and serves Rojo on the same port. So a deleted output
folder or a reinstalled `node_modules` recovers. A failed compiler starts again
too. It names the parts that a `forge start` terminal owns in `data.kept` and
leaves them alone; `--force` restarts them too, and they keep their owner. A
found Studio stays open (unless `--force`); the compiler and Rojo restart, and
Rojo keeps its port. It returns when no part is starting. It takes
`--recovery <mode>` and `--studio-path <path>`.

`status --wait` returns the status once the compiler's last build is fresh: a
compile started after the newest edit under the tsconfig's `rootDir` (see
`rbxts.project`), no compile runs, and none started for a short quiet window.
Run it after an edit. When the compiler starts no compile for that edit within
10 s, it fails with `edit_not_compiled`. `--timeout <seconds>` bounds the wait
(default 300), else it fails with `compile_timeout`. `--timeout 0` does not
wait: it returns the status now. With no roblox-ts compiler in the session, it
returns at once.

One session runs per project (per worktree and build output). A second `up`
joins the running session and adds its missing parts; a `start` joins it as its
owner, and fails with `session_running` while another `start` owns it. A new
session waits until every process of a crashed old one is gone. After 30 minutes
with no activity (a command that talks to the session, a compile start, or a
Studio save), a session stops its parts with no owner, as `down` does, and
leaves a found Studio open; set it with `session.idleTimeout`.

One-shot commands:

| Command          | What it does                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `forge init`     | Create `rbx-forge.config.ts`. `--type <rbxts\|luau>`, `--force` to replace.                                                     |
| `forge config`   | Print the resolved config.                                                                                                      |
| `forge build`    | Build the Rojo project. `-o, --output <path>`, or `--plugin <name>` for Studio's plugins folder.                                |
| `forge compile`  | Compile roblox-ts once and report errors (rbxts only). While a session runs: see below.                                         |
| `forge open`     | Build a snapshot of the place and open it in Studio, outside every session. `--studio-path <path>`, `--desktop <user\|hidden>`. |
| `forge stop`     | Close the session's Studio (and stop its Rojo) or the Studio of a place, after it verifies it. See below.                       |
| `forge syncback` | Sync the place back into the project once. `--input <path>`, `--project <path>`.                                                |
| `forge typegen`  | Write service types from the Rojo sourcemap. `-o`, `--include`, `--exclude`, `--max-depth` (rbxts only).                        |

`stop` closes the session's Studio and stops its Rojo; the compiler keeps
running, and an `up` session with no part left ends. A Studio that a
`forge start` terminal owns fails with `studio_owned` (exit 1), and a found
Studio with `studio_found` (exit 1); `--force` closes both. With no session
Studio, `stop` closes the Studio that the place's lock file names. It also
closes every snapshot Studio. `--place <path>` selects one place, and
`--recovery <mode>` handles the auto-recovery files.

`open` builds a snapshot of the place into `.forge/snapshots/` and opens it with
no session and no Rojo, the same with or without a running session. It keeps the
five newest snapshots, and every snapshot that a Studio has open. A snapshot is
a normal place file: `forge syncback --input <snapshot>` syncs changes made in
it back into the project.

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

forge is built for AI agents too. Every command has `--json` output, never
prompts when it cannot ask, and ends with a stable error code and exit code (see
[docs/json-output.md](./docs/json-output.md)).

The `rbx-forge` skill teaches an agent the dev loop. Install it in your project:

```bash
npx skills add christopher-buss/rbx-forge
```

With the skill, an agent:

- Starts a background session with only the compiler (`forge up`), and reads the
  build of each edit with `forge status --wait` instead of compiling itself.
- Opens Studio only to verify or debug: a snapshot with `forge open` for a
  one-time look, or `forge up --studio` to work in Studio with Rojo. It closes
  each Studio it opens.
- Runs `forge sync` after you save the place in Studio.
- Leaves the parts of your `forge start` terminal alone, and stops only the
  session it started.

A session that no one uses stops after `session.idleTimeout` minutes, so a
forgotten agent session does not stay open.

## Contributing

Tools are pinned in `mise.toml`: `mise install`, then `pnpm install`. Read
[CONTRIBUTING.md](./CONTRIBUTING.md) for the scripts and checks, and
[AGENTS.md](./AGENTS.md) for the code layout and test rules.

## License

[MIT](./LICENSE) (c) Christopher Buss. Portions (c) osyrisrblx, from
rbxts-build.
