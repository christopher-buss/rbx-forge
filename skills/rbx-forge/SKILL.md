---
name: rbx-forge
description:
  Use before changing code, building, or using Roblox Studio in a Roblox
  project, and when syncing Studio edits back.
---

# rbx-forge

forge runs a **session** in the background, one per worktree. Its **parts** are
the watch-mode compiler and, when you ask, a Studio with its Rojo. The compiler
part rebuilds on every save, so you read its builds instead of compiling.

Run forge from the project root through the project's package manager
(`pnpm exec forge`, `npx forge`), with `--json` on every command. The last line
is the `result`: `ok`, then `data`, or `error` with a stable `code`, `message`,
and `hint`. Branch on `error.code` and the exit code.

## Loop

1. **Start**: `forge up --json` once, at the start of the task. It starts a
   session with the compiler alone, or joins the running one. The session is
   yours when `data.started` is `true`.
2. **Edit** the code.
3. **Read the fresh build**: `forge status --json --wait`. It waits for the
   compile of your last edit, then gives `data.services.compiler.lastBuild`:
   `errors`, and `diagnostics` with `file`, `line`, `column`, `code`, `message`.
   Only `--wait` makes the build **fresh**; a plain `status` can show the build
   before your edit. A Luau watch command reports no builds: `status --wait`
   returns at once with no `lastBuild`, and `forge logs compiler` has its
   output.
4. **Test**: with a fresh build at 0 errors, run the unit tests on the compiled
   output. Go back to step 2.
5. **End**: `forge down --json` when the task is done and the session is yours.
   Leave a session someone else started running.

## Failures

- `service_failed` from `status --wait`: the compiler part stopped.
  `forge logs compiler` has its output. Fix the cause, then `forge up --json`
  starts it again.
- `not_running` (exit 3): no session runs. After `session.idleTimeout` minutes
  (default 30) with no activity, a session stops its parts with no owner.
  `forge up --json`, then continue.
- `session_replaced` (exit 3): a new session runs in place of yours.
  `forge up --json` joins it (`data.started: false`), so it is not yours.
- `compile_timeout`: no fresh build came within 300 s. Read
  `forge logs compiler`.
- `edit_not_compiled`: the compiler started no compile for the edited file in
  `error.details.path`. Save it again, or read `forge logs compiler`.
- A deleted output folder or a reinstalled `node_modules`:
  `forge restart --json` restarts the parts with no owner.
- `session_stopping` (exit 6): the session is still ending. Run the command
  again once it is gone.
- Other exit 5 or 6 errors: forge cannot verify or stop a process. Report the
  `error` to the user.

## Studio

Studio is for verification and debugging; the loop above runs without it. Close
each Studio you open, once you are done with it.

- **Look once**: after a fresh build, `forge open --json` builds a **snapshot**
  of the place (`data.place`) and opens it outside the session.
  `forge stop --place <data.place> --json` closes that Studio alone. Edits in a
  snapshot stay in the snapshot; to see a new edit, stop and open again. `down`
  and the idle timeout leave snapshot Studios open.
- **Change in Studio**: `forge up --studio --json` **attaches** a Studio and its
  Rojo to the session, and Rojo live-syncs your edits. Rojo serves on
  `data.services.rojo.port`; give that port to the user and ask them to connect
  the Rojo plugin. When you know at the start that you will work in Studio, use
  this instead of a snapshot. `forge stop --json` closes the Studio and its
  Rojo, and every snapshot Studio; the compiler runs on.
- **The user's Studio**: when `up --studio` reports that a Studio already has
  the place open, the session uses that Studio. It is the user's: ask the user
  before you close it, and `forge sync` after their save first.
- Play, and read the console, with the Roblox Studio MCP.
- **Syncback**: after the user saves the place, `forge sync --json` pulls the
  Studio edits into the project and runs its hooks; read the files it changed
  before you edit them. `stop`, `restart`, `down`, and the idle timeout close
  Studio without a save, so sync each save first.

## Owners

A part with `owner: "start"` belongs to the user's `forge start` terminal, and
stays theirs. `down` keeps it and succeeds (`data.parts.kept`). `stop` on their
Studio fails with `studio_owned`: tell the user, and leave that Studio open.
Other agents in the worktree share the session too, so `restart` and `down`
reach their work as well.

## Setup

**No config file, a config or tool error** (`config_not_found`,
`config_invalid`, `config_load_failed`, `compiler_missing`, `rojo_missing`,
`native_missing`), **or a change to the config or to generated service types**:
see [SETUP.md](SETUP.md).
