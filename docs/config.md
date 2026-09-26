# Configuration

forge reads one config file in the project root: `rbx-forge.config.ts`
(`forge init` writes it). c12 loads it, so `.js`, `.mjs`, `.json`, `.yaml`, and
`.toml` also work. Run forge from the project root: it does not search parent
folders.

```ts
import { defineConfig } from "rbx-forge";

export default defineConfig({
	projectType: "rbxts",
});
```

`defineConfig` only adds types. `forge config` prints the resolved config.

## Rules

- **Required file.** A command that reads the config fails with
  `config_not_found` when the file is missing. `init`, `status`, `sync`, and
  `logs` do not read it. `down` reads only `studio.autoRecovery`, and runs
  without the file.
- **Strict.** An unknown key is an error (`config_invalid`).
- **Precedence.** Flags, then the config file, then the defaults. Objects merge
  key by key. Every other value, arrays included, replaces the value below it.
- **Paths** are relative to the project root and must not be empty.
- **Commands** (`rojoAlias`, `rbxts.command`, `luau.watch.command`) resolve to a
  bin of a project dependency first (run with the current Node, never through a
  `node_modules/.bin` shim), then to `PATH`.

## Options

### `projectType`

- Type: `"rbxts" | "luau"`
- Default: none. **Required.**

What the project compiles from. `"luau"` turns off `forge compile` and
`forge typegen` (`command_unavailable`), and the session uses `luau.watch` as
its compiler.

```ts
defineConfig({
	projectType: "luau",
});
```

### `buildOutputPath`

- Type: `string`
- Default: `"game.rbxl"`
- Flag: `forge build --output <path>`

The place or model file that `forge build` and the session build write. `open`
and `syncback` fall back to it. forge runs one session per project tree and
build output, so two build outputs of one tree are two sessions.

```ts
defineConfig({
	buildOutputPath: "build/game.rbxl",
});
```

### `rojoAlias`

- Type: `string`
- Default: `"rojo"`

The Rojo command, for example a pinned or wrapped Rojo.

```ts
defineConfig({
	rojoAlias: "rojo-quenty",
});
```

### `rojoProjectPath`

- Type: `string`
- Default: `"default.project.json"`

The Rojo project file for `build`, `serve`, `sourcemap` (typegen), and the
fallback of `open.projectPath` and `syncback.projectPath`.

```ts
defineConfig({
	rojoProjectPath: "build.project.json",
});
```

### `rojoPort`

- Type: `integer`, 1 to 65535
- Default: none

The port of `rojo serve` in a session. A session chooses it when Rojo first
starts (`forge start`, or `forge up --studio`), and keeps it for its whole life:
a Rojo that starts again, such as after `forge up` repairs it, serves on the
same port, so its Studio connects to the same server.

- **Set**: the port is fixed. forge never picks another port: a busy port fails
  with `port_in_use`.
- **Not set**: forge takes `34872` (Rojo's default) when it is free, else a free
  port the OS gives out. So sessions in several worktrees can each attach a
  Studio. `forge status` and `services.rojo.port` in the state contract show the
  port.

Rojo is ready only when it accepts connections on `127.0.0.1` at this port. When
it does not within 60 s, forge stops it and its part is `failed`; the session
goes on. A `serveAddress` in the Rojo project file that does not listen on
`127.0.0.1` (for example a LAN address) makes Rojo fail this way; `0.0.0.0` is
fine.

```ts
defineConfig({
	rojoPort: 34873,
});
```

### `gracefulTimeoutMs`

- Type: `integer` >= 0
- Default: `3000`

How long workers get to stop after a graceful stop request (Ctrl+Break on
Windows, `SIGTERM` elsewhere), before forge kills their process trees. A new
session waits up to `gracefulTimeoutMs` + 15 s for the processes of an old
session to go. When `forge down`'s stop request times out, its second, forced
request ends this grace at once.

```ts
defineConfig({
	gracefulTimeoutMs: 10_000,
});
```

### `hooks`

- Type:
  `{ build?, compile?, open?, syncback?, typegen?: { pre?: string[], post?: string[] } }`
- Default: `{}`

Shell commands to run around a command's step. See
[How hooks run](#how-hooks-run).

```ts
defineConfig({
	hooks: {
		build: { pre: ["pnpm run codegen"] },
		syncback: { post: ["pnpm eslint --fix src"] },
	},
});
```

### `hookTimeoutMs`

- Type: `integer` >= 1
- Default: `300000` (5 minutes)

How long one hook may run. A hook that runs longer is killed with its whole
process tree, and fails (`hook_failed`, outcome `timed_out`).

```ts
defineConfig({
	hookTimeoutMs: 60_000,
});
```

### `rbxts`

Options for the roblox-ts compiler (`projectType: "rbxts"`).

#### `rbxts.command`

- Type: `string`
- Default: `"rbxtsc"`

The compiler command. A missing compiler gives `compiler_missing`.

forge reads the output of rbxtsc, and the JSON output of
[sloptor](https://github.com/howmanyslop/sloptor). It finds the format on each
line:

- A JSON object with a string `event` field is a watch-mode event of
  `sloptor build -w --json`.
- A JSON object with `ok` and `diagnostics` is the result of a one-shot
  `sloptor build --json` (`forge compile`, and the first compile of a session).
- All other lines are rbxtsc text.

A sloptor build with `ok: false` counts at least one error. There is no option
for the format. For sloptor:

```ts
defineConfig({
	rbxts: { args: ["build", "--json"], command: "sloptor" },
});
```

#### `rbxts.args`

- Type: `string[]`
- Default: `[]`

Arguments for every compiler run. The session's watch-mode compiler adds `-w`.

```ts
defineConfig({
	rbxts: { args: ["--verbose"] },
});
```

### `luau`

Options for Luau projects (`projectType: "luau"`).

#### `luau.watch.command`

- Type: `string`
- Default: none

The watch command the session runs as its compiler service, for example darklua.
With no command, a Luau session runs no compiler and does not build before it
opens Studio (the `open` step still builds when `open.buildFirst` is on).

#### `luau.watch.args`

- Type: `string[]`
- Default: `[]`

Arguments for the watch command.

```ts
defineConfig({
	luau: {
		watch: { args: ["process", "src", "out", "--watch"], command: "darklua" },
	},
});
```

### `open`

Options for `forge open` and the session's open step.

#### `open.buildFirst`

- Type: `boolean`
- Default: `true`
- Flag: `forge open --build` / `--no-build`

Build the place before opening it. When off and the place is missing, forge asks
at a terminal (answering no fails with `declined`); a run that cannot ask fails
with `place_not_found`.

#### `open.buildOutputPath`

- Type: `string`
- Default: `buildOutputPath`
- Flag: `forge open --place <path>`

The place to open (and to build, when building first). `forge stop` also looks
for Studio's lock file next to this place.

#### `open.projectPath`

- Type: `string`
- Default: `rojoProjectPath`

The Rojo project to build before opening.

```ts
defineConfig({
	open: { buildFirst: false, buildOutputPath: "test.rbxl" },
});
```

The Studio executable is not a config option: its path differs per computer. Use
`--studio-path` or `RBX_FORGE_STUDIO_PATH` (see
[Opening Studio](./studio.md#opening-studio)).

### `session`

Options for the sessions of `forge start` and `forge up`.

#### `session.idleTimeout`

- Type: `number` >= 0, in minutes (fractions allowed)
- Default: `30`

After this many minutes with no activity, a session stops its parts with no
owner, as `forge down` does: the compiler, Rojo, and Studio. It closes Studio as
`stop` does, with its auto-recovery files handled as
[`studio.autoRecovery`](#studioautorecovery) says. A part that a `forge start`
terminal owns is never stopped. An `up` session with no part left ends. Activity
is a client request (any forge command that talks to the session, such as
`status` or `up`), a compile start, or a Studio save of the place. `0` turns the
timeout off.

```ts
defineConfig({
	session: { idleTimeout: 120 },
});
```

### `studio`

Options for the Roblox Studio that `stop`, `down`, and the idle timeout close.

#### `studio.autoRecovery`

- Type: `"move" | "delete" | "keep"`
- Default: `"move"`
- Flag: `forge stop --recovery <mode>` / `forge down --recovery <mode>`

What forge does with the auto-recovery files of a Studio it ended: `move` them
to `.forge/recovery/` (the 5 newest stay), `delete` them, or `keep` them in
Studio's AutoSaves folder, where the next launch offers to recover them. See
[Auto-recovery](./studio.md#auto-recovery). `down` also runs when the config
file is missing or invalid: then only `--recovery` and the default count.

```ts
defineConfig({
	studio: { autoRecovery: "delete" },
});
```

### `syncback`

Options for syncback: Studio edits back into the project. Syncback needs Rojo
7.7 or later (`syncback_unsupported` otherwise); see `rojoAlias`.

#### `syncback.inputPath`

- Type: `string`
- Default: `buildOutputPath`
- Flag: `forge syncback --input <path>`

The place file syncback reads. The session's save watch watches this file.

#### `syncback.projectPath`

- Type: `string`
- Default: `rojoProjectPath`
- Flag: `forge syncback --project <path>`

The Rojo project syncback writes.

#### `syncback.runOnStart`

- Type: `boolean`
- Default: `false`
- Flag: `forge start --syncback` / `forge up --syncback`

Run syncback and its hooks each time the place file is saved during a session.
Saves during a run start one more run after it. `forge sync` works in every
session, with or without this option.

```ts
defineConfig({
	syncback: { runOnStart: true },
});
```

### `typegen`

Options for `forge typegen` (rbxts only), which writes service types from the
Rojo sourcemap.

#### `typegen.outputPath`

- Type: `string`
- Default: `"src/services.d.ts"`
- Flag: `forge typegen --output <path>`

The declaration file to write.

#### `typegen.include`

- Type: `string[]`
- Default: `["**"]`
- Flag: `forge typegen --include <glob>` (repeat for more; replaces the list)

Instance path globs to type, such as `ReplicatedStorage/**`. `/` separates
instance levels; `**` matches any number of levels, `*` any run of characters in
one level, `?` one character.

#### `typegen.exclude`

- Type: `string[]`
- Default: `["**/node_modules/**"]`
- Flag: `forge typegen --exclude <glob>` (repeat for more; replaces the list)

Instance path globs to leave out, with everything under them.

#### `typegen.maxDepth`

- Type: `integer` >= 1
- Default: none (no limit)
- Flag: `forge typegen --max-depth <n>`

The deepest instance level to type. A service is level 1.

```ts
defineConfig({
	typegen: {
		include: ["ReplicatedStorage/**", "Workspace/Map/**"],
		maxDepth: 4,
		outputPath: "src/types/services.d.ts",
	},
});
```

## How hooks run

A hook is a shell command that forge runs before (`pre`) or after (`post`) a
command's step. Declare hooks in the config file with the [`hooks`](#hooks)
option.

- Hook keys: `build`, `compile`, `open`, `syncback`, `typegen`. `start` and `up`
  have none; their steps run the hooks of the commands above.
- `pre` hooks run in order before the step. A failure aborts the command.
- `post` hooks run in order only after the step succeeds. A failed `post` hook
  fails the command.
- Chained steps run their own hooks. `forge open` that builds first runs: `open`
  `pre`, `build` `pre`, the build, `build` `post`, Studio, `open` `post`.
- Each hook runs through the system shell (`cmd.exe` on Windows, `/bin/sh`
  elsewhere) in the project root, with `node_modules/.bin` first on `PATH`. The
  hooks work the same with pnpm, npm, bun, mise, or no task runner. forge does
  not read `package.json` scripts or mise tasks.
- In a session, each hook is a worker: it stops with the session.
- A hook that runs forge cannot trigger itself again: a hook already running
  above is skipped (outcome `skipped`), and nesting deeper than 8 fails with
  `hook_depth_exceeded`.
- Each hook result (`id`, `command`, `outcome`, `exitCode`, `durationMs`,
  `outputTail`) is in the command's `--json` result, in `error.details.hooks` on
  failure, and for syncback in `forge status`.
