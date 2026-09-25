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

## Decisions

- **Build events, not text.** A pure freshness tracker takes build events
  (start, and end with the error count and diagnostics) and the time. The
  roblox-ts line parser turns output lines into these events, so an adapter for
  another compiler's output feeds the same tracker unchanged.
- **Unanswered start lines.** A roblox-ts fork prints a start line for a save
  during a compile and folds several of them into one trailing compile, so start
  lines and summary lines do not always pair. Each summary line ends the oldest
  open compile. Start lines that a summary line leaves open count as merged once
  no output comes for twice the longest compile so far (at least one quiet
  window), or once a new start line comes. A compile that runs silently for
  longer than that can show as done too soon; `--timeout` bounds every other
  case.
- **No compiler to read.** A session with no roblox-ts compiler (Luau, or
  `--no-compiler`) answers at once. A session that is still starting waits for
  its first build.
- **Failures.** No fresh build within `--timeout` (default 300 s) gives
  `compile_timeout`; a compiler that stops during the wait gives
  `service_failed`; a session that stops gives `not_running`.

## Considered options

- **forge watches the files itself.** Its file set can differ from the
  compiler's (roblox-ts also watches the Rojo project and copies non-TypeScript
  files), so a save that the compiler ignores could make forge wait forever.
  Rejected.
- **A new `forge compile --session` command.** A second surface for what
  `status` already returns. Rejected.
- **Only a `building` field.** It still races: right after a save, no start line
  has come yet, so `building` is `false`. Kept as a field, not as the answer.
