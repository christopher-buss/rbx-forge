# JSON output and exit codes

What forge writes for scripts and AI agents, and what its exit codes mean.

## NDJSON

With `--json`, or when stdout is not a terminal, forge writes NDJSON: one event
per line (`step`, `info`, `warning`, `compiled`, `log`), then one final line:

```text
{"type":"result","command":"status","ok":true,"data":{...}}
{"type":"result","command":"down","ok":false,"exitCode":6,"error":{"code":"cleanup_in_progress","message":"...","hint":"...","details":{...}}}
```

`forge logs <name> --json` gives one `log` event per line.

A run that cannot prompt (not a terminal, `--json`, or `CI`) never prompts: it
takes a safe default or fails with `needs_confirmation`.

## Exit codes

| Exit | Meaning                                                 | Error codes                                                                                       |
| ---- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 0    | success                                                 |                                                                                                   |
| 1    | failure (config, tool, hook, or declined prompt)        | every code not listed below, such as `compile_timeout` and `service_failed`                       |
| 2    | unreadable command line                                 | `usage`                                                                                           |
| 3    | no session is running                                   | `not_running`, `session_replaced`                                                                 |
| 4    | needs confirmation, and the run cannot prompt           | `needs_confirmation`                                                                              |
| 5    | cannot verify a process identity; nothing was killed    | `identity_mismatch`, `cleanup_unverifiable`                                                       |
| 6    | cleanup in progress, or the supervisor does not respond | `cleanup_in_progress`, `previous_generation_alive`, `session_stopping`, `supervisor_unresponsive` |
| 130  | interrupted                                             | `interrupted`                                                                                     |

Error codes are stable: a code is never renamed or reused. The full list is in
[`src/errors.ts`](../src/errors.ts).

## Agent loop

1. `forge up --json`: start a session with the watch-mode compiler alone, or
   find the running one (`data.started`). On a running session, it starts the
   parts it asks for that are `off` or `failed`, and never touches a part that
   runs. `data.added` names the parts this `up` started (`[]` when none).
   Returns when no part is `starting`: the first compile is done, or the part
   failed (see [Parts](#parts)). A project with no compiler gets a session with
   no part. `forge restart --json` restarts every part with no owner, the
   compiler first (see [The `restart` result](#the-restart-result)).
2. Edit code.
3. `forge status --json --wait`: `data.services.compiler.lastBuild` has `errors`
   and `diagnostics` (`file`, `line`, `column`, `code`, `message`, `severity`),
   and `startedAt` and `at` (when the compile started and ended). `--wait` makes
   it the build of your edit; see below. `data.services.studio` has `status`
   (`opening`, `open`, `closed`, `off`), `place`, and, for a Studio forge
   started or attached, `pid` and `startTime`.
4. To play, `forge up --studio --json` attaches Studio and Rojo to the session
   (`data.added` names `studio` and `rojo` when it started them), and returns
   once Rojo listens and Studio has the place open; read the console with the
   Roblox Studio MCP. A Studio that has the place open already is used. A busy
   configured `rojoPort` fails with `port_in_use`; with none set, the session
   picks a port, in `data.services.rojo.port`. `forge open --json` builds a
   snapshot and opens it outside the session, for a one-time look: `data.place`
   is the snapshot, `data.pruned` the old snapshots it deleted.
5. `forge sync --json`: pull Studio edits into the project, with the syncback
   hooks. It waits for a running save-triggered run, then runs once more.
   Failures keep their code, with hook results in `error.details.hooks`.
6. `forge down --json`: stop the parts with no owner, and the session once none
   is left. See below for its result. A session no command talks to, with no
   compile start and no Studio save, does the same by itself after
   [`session.idleTimeout`](./config.md#sessionidletimeout) minutes (30 by
   default).

Exit 6 means processes still live or the supervisor does not answer: retry with
`--force`. Exit 5 means forge could not verify a process, so it killed nothing.

## Parts

`data.services.compiler` and `data.services.rojo` are parts of the session. Each
has:

- `status`: `starting`, `ready`, `off` (not run, or stopped on request), or
  `failed` (its service exited by itself).
- `owner`: `start` (the `forge start` terminal that owns it) or `null`. A
  `start` owns the parts it started and those it took when it joined; its end
  stops the first and gives back the second (`owner` becomes `null`).
- With `failed` only: `exitCode` (`null` when a signal ended it) and
  `outputTail`, the last lines of its output. `forge logs <part>` has all of it.

A service's exit stops only its part: the session and its other parts keep
running. A second `forge up` (or `forge restart`) starts a `failed` compiler
again, as a new part, and the `failed` Rojo of an attached Studio on the same
port. When a Studio that `up --studio` attached closes the place, only its Rojo
stops (`off`); when a Studio that a `start` owns closes it, nothing stops. The
phase is `ready` once the session started its parts and none is `starting`, also
with a part `off` or `failed`. `data.services.studio` also has `owner`.
`data.services.rojo.port` is there once the session chose Rojo's port; it keeps
it from then on.

## `start` and its parts

A `forge start` that started its session ends with the session's result:
`data.reason` (`SIGINT`, `owner_gone`, `shutdown`, …) and every worker's report.
When its end leaves the session running (a part with no owner runs on), or when
it joined a running session, its result names what letting go did:

- `stopped`: the services it started, now stopped.
- `studioLeft`: `true` when the session let go of the Studio it opened; that
  Studio stays open.
- `released`: the parts it took, which run on with no owner.
- `ending`: `true` when no part was left, so the session ends.
- `sessionId`.

A `start` that joined reports `Joined session <id>: …` first. When the session
ends while it holds it, it returns `data.ending: true` with no other field.

## Fresh builds: `status --wait`

A plain `forge status` right after a save can return the build before it: the
watch-mode compiler has not started yet. `data.services.compiler.building` is
`true` from a compile's start line to its summary line, but a save that has not
started a compile shows `false` too.

`forge status --wait` asks the session to answer once the last build is fresh:

1. It waits for the compile that runs, if any.
2. Then it waits for a quiet window (750 ms) with no new compile. A compile that
   starts in the window restarts the wait.
3. It returns the normal status.

An edit that starts no compile (a file the compiler does not watch) returns
after one window with the last build. A session that is still starting waits for
its first compile. With no roblox-ts compiler (Luau, or `--no-compiler`), it
returns at once.

`--timeout <seconds>` (default 300, at most 2147000; decimals are allowed)
bounds the wait. `--timeout 0` does not wait: it returns the status now, with
`building`, and never fails with `compile_timeout`.

Failures: `compile_timeout` (exit 1) when the wait ends with no fresh build,
with `details.building` and `details.timeoutSeconds`. A `--timeout` above 0 and
shorter than the quiet window (0.75 s) always fails when a roblox-ts compiler
runs; `service_failed` (exit 1) when the compiler stops during the wait;
`not_running` (exit 3) when no session runs or it stops.

`forge compile --json` in a running session gives the same fresh build as a
compile result: `data.diagnostics`, `data.errors`, `data.durationMs`,
`data.hooks`, `data.log` (the session's compiler log), and `data.sessionId`. A
build with errors fails with `compile_failed` and the same fields in
`error.details`. A session whose compiler does not run fails with `compiler_off`
(exit 1, `details.status`).

## The `down` and `stop` result

`down` and `stop` act only on parts with no owner. `data.parts` names what they
did: `stopped` (the parts, Studio first) and `kept` (each part with its `owner`,
left because a `forge start` terminal owns it). It is `null` when no session
said: for `down`, the session did not answer or was stopping, and `down` stopped
it whole; for `stop`, no session runs. A session that is still starting answers
once it started its parts. `down` never stops a session whole while a
`forge start` terminal owns a part of it: when that session does not answer,
`down` fails (such as with `supervisor_unresponsive`), unless `--force`.

`down` never fails because of an owner. `data.status` is `stopped` once the
session is gone (an `up` session with no part left ends), or `running` when
owned parts keep it. `data.stoppedBy` (only with `stopped`) is `shutdown`,
`forced_shutdown`, `killed`, or `gone`.

`data.studio.status` is one of:

- `closed`
- `kept` (`--keep-studio`, or Studio has an owner)
- `none` (no Studio open)
- `unknown` (the supervisor did not answer, so forge touched no Studio)
- `failed`, with the error's `code` and `message`. Studio may still be open; the
  session still stops.

A `closed` Studio also has:

- `end`: `exited`, `lock_released` (closed the place, then forge ended the
  process), `dialog`, `timeout`, or `no_window`.
- `forced: true` when forge ended it without a save. It stays `false` after
  `lock_released`: the place closed first.
- `recovery`: `null` for `exited`, or `mode`, `moved` (`from`, `to`), `deleted`,
  `warnings`. forge handles the auto-recovery files after every kill, also after
  `lock_released`. See [Auto-recovery](./studio.md#auto-recovery).

`forge stop` reports the same Studio fields in `data`, with `stopped`, `parts`,
and `snapshots`: the same fields for each snapshot Studio it closed (none with
`--place`). It closes the session's Studio with its Rojo; the compiler keeps
running. A Studio that a `forge start` terminal owns fails with `studio_owned`
(exit 1, `details.owner`, `details.sessionId`, and `details.pid` and
`details.place` when known); `stop --force` closes it. A session that stops
while `stop` asks it fails with `session_stopping` (exit 6,
`details.sessionId`): forge closes no Studio that may be the session's; run
`stop` again once the session is gone. `--place <path>` selects the Studio of
one place, such as a snapshot that `forge open` opened.

## The `restart` result

`forge restart --json` returns the session's status once no part is starting,
with:

- `stopped`: the parts it stopped, Studio first.
- `added`: the parts it started again, the compiler first, then Studio and Rojo.
- `kept`: each running part with its `owner`, left because a `forge start`
  terminal owns it. With `--force` it is empty, and the restarted parts keep
  their owner.

It restarts only the parts that run with no owner (all with `--force`), and a
`failed` compiler with no owner. Studio closes as for `stop`, and a new Studio
opens once the compiler's first build is done; Rojo keeps its port. Failures:
`not_running` (exit 3) with no session; `cleanup_in_progress` (exit 6,
`details.parts`) when a stopped service's process tree is not proven gone, with
nothing started again; Studio's close failure, such as `identity_mismatch`; an
add failure, such as `compiler_missing` or `port_in_use`.
