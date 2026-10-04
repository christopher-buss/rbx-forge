---
status: accepted
---

# Compile freshness: a quiet window on the compiler's own output

An agent that runs `forge status` right after a save can read the build before
its edit: the watch-mode compiler has not printed its start line yet. So
`forge status --wait` asks the supervisor to answer once the last build is
fresh. The supervisor reads the compiler's output: it waits for the compile that
runs, then for a quiet window with no new start line, and a compile that starts
in the window restarts the wait. The quiet window is 750 ms: roblox-ts prints
its start line about 61 ms after a save, and the session reads the compiler's
output every 250 ms.

A watcher can see a save much later than that: sloptor polls the tree and does
not start a compile while one runs, so its start line came 6 s and 37 s after an
edit, and the wait answered with the build before it. So the wait also reads the
sources' modification times once, and a compile must start after the newest
edit.

## Decisions

- **Build events, not text.** A pure freshness tracker takes build events
  (start, and end with the error count and diagnostics) and the time. The
  roblox-ts line parser turns output lines into these events, so an adapter for
  another compiler's output feeds the same tracker unchanged. The second adapter
  reads the NDJSON events of `sloptor build -w --json`
  ([howmanyslop/sloptor#67](https://github.com/howmanyslop/sloptor/issues/67)):
  a line that is a JSON object with a string `event` field is a sloptor event,
  and all other lines go to the roblox-ts parser.
- **Unanswered start lines.** A roblox-ts fork prints a start line for a save
  during a compile and folds several of them into one trailing compile, so start
  lines and summary lines do not always pair. Each summary line ends the oldest
  open compile. Start lines that a summary line leaves open count as merged once
  no output comes for twice the longest compile so far (at least one quiet
  window), or once a new start line comes. A compile that runs silently for
  longer than that can show as done too soon; `--timeout` bounds every other
  case.
- **Source edits.** At the start of each wait, forge finds the newest
  modification time under the root directories of the compiler's tsconfig
  (`rootDirs`, else `rootDir`; `-p` or `--project` in `rbxts.args` names it),
  outside `outDir`, `node_modules`, and hidden entries. Times after the wait
  began do not count. When that edit is newer than the last compile start, the
  wait also needs a compile that starts at or after it. A tsconfig forge cannot
  read, or one with no root directory, gives no edit: the quiet window alone
  answers.
- **Edits with no compile.** The compiler can ignore an edited file. A pickup
  window, from the call or the end of the last compile, bounds the wait for a
  compile of the edit; after it the wait fails with `edit_not_compiled`, which
  names the file. It is long, because a watcher can take tens of seconds.
- **No compiler to read.** A session with no roblox-ts compiler (Luau, or
  `--no-compiler`) answers at once. A session that is still starting waits for
  its first build.
- **Failures.** No fresh build within `--timeout` (in seconds, as for `down`;
  default 300) gives `compile_timeout`; a compiler that stops during the wait
  gives `service_failed`; a session that stops gives `not_running`. A timeout
  above 0 and shorter than the quiet window (0.75 s) always fails while a
  compiler runs.
- **`--timeout 0` does not wait.** It returns the status now, with `building`,
  and never gives `compile_timeout`: an agent can read the state without a wait.

## Considered options

- **forge watches the files itself.** A watcher runs all session long, and its
  file set can differ from the compiler's (roblox-ts also watches the Rojo
  project and copies non-TypeScript files), so a save that the compiler ignores
  could make forge wait forever. Rejected: forge reads modification times once
  per wait, and the pickup window bounds an ignored save.
- **The quiet window alone.** It answers with the build before a save that the
  watcher sees late. Rejected.
- **A new `forge compile --session` command.** A second surface for what
  `status` already returns. Rejected.
- **Only a `building` field.** It still races: right after a save, no start line
  has come yet, so `building` is `false`. Kept as a field, not as the answer.

## Consequences

- Each wait walks the source roots once: one directory read per directory and
  one `stat` per file.
- The pickup window (`EDIT_PICKUP_MS`) and the quiet window (`QUIET_WINDOW_MS`)
  are a tuning surface. A watcher slower than the pickup window gives
  `edit_not_compiled` for an edit it would still compile.
- A deleted file changes no file's modification time, so the wait does not wait
  for its compile.
