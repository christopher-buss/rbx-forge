---
status: accepted
---

# Sessions: one supervisor process, a singleton lock, and barriers

Every session runs in its own supervisor process (`dist/supervisor.mjs`), also
for `forge start`. There is no in-process session mode, and no forge command
starts another forge command: chained steps are function calls. We chose this
because the old design (task-runner chains, cleanup that killed the task runner)
leaked `rojo` and `rbxtsc` processes (#25), and because `start` must stop every
process when it is hard-killed at any moment, which an in-process session cannot
do.

## Decisions

- **Two launch modes, one runtime.** `start` spawns the supervisor with an owner
  pipe (the supervisor's stdin; `start` holds the only write end). End of file
  at any time, also during startup, stops the session. `up` spawns it detached
  (Windows: breakaway, see ADR 0001) and returns when the session is ready.
- **The supervisor is detached on every OS, also for `start`.** On Windows,
  libuv puts a non-detached child in a `KILL_ON_JOB_CLOSE` job, so a killed
  `start` killed the supervisor before it could clean up. The owner pipe, not
  the job, ties the session to `start`. `start` forwards its stop signals.
- **Singleton.** The supervisor holds an exclusive lock on
  `.forge/supervisor.lock` for its whole life. Only the holder may remove a
  stale endpoint, create the endpoint, delete session directories, or rewrite
  `.forge/current`. A second `start` or `up` gets `session_running`; `up` then
  joins the running session.
- **Startup order under the lock.** Barrier for every old session directory
  (bound `gracefulTimeoutMs + 15 s`, then `previous_generation_alive` with the
  PIDs; `--force` runs forced cleanup), port check (`port_in_use`), new session
  directory with the identity record and token, endpoint, then the reaper.
- **Admission.** The reaper takes its lease, reports `leased`, and spawns
  nothing until the supervisor sends `go`. Once shutdown begins, admission is
  closed for good. So a worker never starts after its supervisor died.
- **One shutdown path.** Close admission, stop the watchers, `terminate` the
  reaper, wait for its report (escalation: close its stdin after
  `gracefulTimeoutMs + 5 s`, forced cleanup 5 s later, `SIGKILL` 2 s later),
  final barrier (5 s, else `cleanup_in_progress`: the session directory stays
  for the next startup barrier), final state, exit.
- **`down` proves the stop.** It reports `stopped` only when (a) the target
  supervisor has exited (its pin is gone; a supervisor lets go of the singleton
  lock before it writes its result, so a free lock proves nothing while the pin
  runs) and (b) the target's barrier is clear. Escalation: IPC `shutdown` (wait
  `--timeout`, 15 s; asked at least once), forced `shutdown` (5 s, ends the
  workers' grace), then with `--force` only: kill the supervisor through its pin
  (only while the singleton lock is held), and forced cleanup when the barrier
  stays blocked. `down` acts only on the session id `.forge/current` named when
  it began; another session at the endpoint gives `session_replaced`.
- **Evidence, not PIDs.** A process belongs to a session only by its marker, its
  lease descriptor (POSIX), its recorded job (Windows), or a recorded pin. Every
  kill goes through a pin and re-checks that evidence. An unverifiable process
  is reported (`cleanup_unverifiable`), never killed.

## Considered options

- **In-process session for `start`.** Simpler, but a hard kill of `start` leaves
  no one to stop the workers. Rejected.
- **PID files and `kill <pid>`.** A reused PID kills an unrelated process.
  Rejected for pins and markers.
- **`down` returns when the supervisor answers `shutdown`.** An agent would race
  a dying session (ports, output folders). Rejected: `down` waits for the
  barrier.

## Consequences

- Every session writes under `.forge/` in the project root. Users must gitignore
  it.
- The final barrier can leave a session directory behind. The next startup
  barrier (or `down --force`) handles it.
