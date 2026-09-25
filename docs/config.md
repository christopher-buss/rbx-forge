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

- **Required file.** With no config file, every command that reads it fails with
  `config_not_found`. Only `init`, `status`, `sync`, `logs`, and `down` do not
  read it.
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
and `syncback` fall back to it. It is also part of the session endpoint key: two
build outputs of one tree are two sessions.

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
- Default: `34872`

The fixed port of `rojo serve` in a session. forge never picks another port: a
busy port fails the session with `port_in_use`. Give each worktree its own port
so each Studio connects to the right server.

The session is ready only when Rojo accepts connections on `127.0.0.1` at this
port, within 60 s (else `service_failed`). A `serveAddress` in the Rojo project
file that does not listen on `127.0.0.1` (for example a LAN address) makes the
session fail; `0.0.0.0` is fine.

```ts
defineConfig({
	rojoPort: 34873,
});
```

### `gracefulTimeoutMs`

- Type: `integer` >= 0
- Default: `3000`

How long workers get to stop after a graceful stop request (Ctrl+Break on
Windows, `SIGTERM` elsewhere), before forge kills their process trees. It also
sets the startup wait for an old session: `gracefulTimeoutMs + 15 s`.
`forge down`'s forced shutdown ends this grace at once.

```ts
defineConfig({
	gracefulTimeoutMs: 10_000,
});
```

### `hooks`

- Type:
  `{ build?, compile?, open?, syncback?, typegen?: { pre?: string[], post?: string[] } }`
- Default: `{}`

Shell commands to run around a command's step. See [Hooks](#hooks).

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
Saves during a run fold into one more run. `forge sync` works in every session,
with or without this option.

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

## Hooks

```ts
defineConfig({
	hooks: {
		syncback: { post: ["pnpm eslint --fix src"] },
	},
	projectType: "rbxts",
});
```

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
