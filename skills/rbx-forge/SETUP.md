# rbx-forge setup

Project setup and the config. The environment is the source of truth here:
`forge --help` and `forge <command> --help` list every flag,
`forge config --json` prints the resolved config, and the `ForgeConfig` type in
`node_modules/rbx-forge/dist/index.d.mts` lists every option.

## Install

- Node.js 24.12 or later; `rbx-forge` as a dev dependency.
- Rojo on `PATH` or as a project dependency. Syncback needs Rojo 7.7 or later
  (`syncback_unsupported`).
- roblox-ts projects: `roblox-ts` as a project dependency (`compiler_missing`
  otherwise).
- `native_missing`: no native build for this platform, or it does not load.
  Reinstall rbx-forge with optional dependencies, else tell the user.
- `.forge/` goes in `.gitignore`: forge keeps its session files, logs, and
  snapshots there.

## Config

`forge init --type <rbxts|luau> --json` writes `rbx-forge.config.ts` and nothing
else. forge reads it only from the project root.

- **Load once**: a running session keeps the config it started with. After a
  config change, `forge down --json`, then `forge up --json`.
- **Strict**: an unknown key fails with `config_invalid`. Read the type before
  you add a key.
- **Precedence**: flags, then the file, then the defaults. Objects merge key by
  key; arrays replace.
- **Compiler**: `projectType: "rbxts"` runs `rbxts.command` (default `rbxtsc`;
  for sloptor, `rbxts: { args: ["build", "--json"], command: "sloptor" }`). A
  Luau project runs `luau.watch.command`, such as darklua; with none, its
  session has no compiler part.
- **`rojoPort`**: leave it unset. forge then takes 34872, else a free port, and
  keeps it for the session, so parallel worktrees each get their own. A set port
  is fixed, and fails with `port_in_use` when it is busy.
- **`session.idleTimeout`**: minutes with no activity before a session stops its
  parts with no owner (default 30; `0` is off).

## Hooks

`hooks.<command>.pre` and `.post` are shell commands around the step of `build`,
`compile`, `open`, `syncback`, or `typegen`, such as
`syncback: { post: ["pnpm eslint --fix src"] }`. They run in the project root
with `node_modules/.bin` on `PATH`; forge does not read `package.json` scripts.
A failed `pre` hook stops the command; a failed `post` hook fails it. Each hook
result is in the `--json` result, and in `error.details.hooks` on failure.

## One-shot commands

- `forge typegen --json` (rbxts) writes service types from the Rojo sourcemap to
  `src/services.d.ts` (`typegen.outputPath`). Run it after the instance tree
  changes.
- `forge build --json` builds the Rojo project into the place file (`-o <path>`,
  or `--plugin <name>` for Studio's plugins folder).
- `forge syncback --input <place> --json` syncs a place file into the project
  with no session, such as a snapshot that the user edited.
