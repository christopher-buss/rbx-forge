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

| Exit | Meaning                                                 | Error codes                                                                   |
| ---- | ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 0    | success                                                 |                                                                               |
| 1    | failure (config, tool, hook, or declined prompt)        | every code not listed below, such as `compile_timeout` and `service_failed`   |
| 2    | unreadable command line                                 | `usage`                                                                       |
| 3    | no session is running                                   | `not_running`, `session_replaced`                                             |
| 4    | needs confirmation, and the run cannot prompt           | `needs_confirmation`                                                          |
| 5    | cannot verify a process identity; nothing was killed    | `identity_mismatch`, `cleanup_unverifiable`                                   |
| 6    | cleanup in progress, or the supervisor does not respond | `cleanup_in_progress`, `previous_generation_alive`, `supervisor_unresponsive` |
| 130  | interrupted                                             | `interrupted`                                                                 |

Error codes are stable: a code is never renamed or reused. The full list is in
[`src/errors.ts`](../src/errors.ts).

## Agent loop

1. `forge up --json`: start the session, or find the running one
   (`data.started`). Returns when Rojo listens and the first compile is done. A
   loop that reads only the compiled output runs
   `forge up --no-open --no-rojo --json`: no Rojo serve, so it takes no
   `rojoPort`, and `data.services.rojo` is `{"status":"off","port":null}`.
2. Edit code.
3. `forge status --json --wait`: `data.services.compiler.lastBuild` has `errors`
   and `diagnostics` (`file`, `line`, `column`, `code`, `message`, `severity`),
   and `startedAt` and `at` (when the compile started and ended). `--wait` makes
   it the build of your edit; see below. `data.services.studio` has `status`
   (`opening`, `open`, `closed`, `off`), `place`, and, for a Studio forge
   started, `pid` and `startTime`.
4. Play and read the console with the Roblox Studio MCP.
5. `forge sync --json`: pull Studio edits into the project, with the syncback
   hooks. It waits for a running save-triggered run, then runs once more.
   Failures keep their code, with hook results in `error.details.hooks`.
6. `forge down --json`: stop the session. See below for its result.

Exit 6 means processes still live or the supervisor does not answer: retry with
`--force`. Exit 5 means forge could not verify a process, so it killed nothing.

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

## The `down` and `stop` result

`data.stoppedBy` is `shutdown`, `forced_shutdown`, `killed`, `gone`, or
`studio_closed` (the session ended by itself once `down` closed its Studio).

`data.studio.status` is one of:

- `closed`
- `kept` (`--keep-studio`)
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

`forge stop` reports the same fields in `data`, with `stopped`.
