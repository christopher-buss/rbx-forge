# rbx-forge

A CLI that runs a Roblox dev loop (compile, build, open Studio, serve Rojo,
syncback) for one Rojo project, and owns every process it starts.

## Sessions

**Session**:\
One running dev environment for one project (one per worktree): its parts, and
an optional syncback watch. It can run with no part.\
_Avoid_: dev server, watch mode, run

**Part**:\
The compiler, Rojo, or Studio of a session. Rojo is a part only together with an
attached Studio.\
_Avoid_: component, piece

**Owner**:\
The `start` terminal that owns a part. Only its owner stops an owned part; any
client, and the idle timeout, can stop a part with no owner.\
_Avoid_: holder, creator

**Idle timeout**:\
The time with no activity (a client request, a compile start, a Studio save)
after which a session stops its parts that have no owner.\
_Avoid_: TTL, expiry

**Supervisor**:\
The Node process that runs one session. `start` binds it to the terminal; `up`
detaches it.\
_Avoid_: daemon, server, host process

**Reaper**:\
The native process (`forge-reaper`, one per session) that creates and owns every
worker at OS level.\
_Avoid_: process manager, spawner

**Worker**:\
Any process the session runs through its reaper: Rojo, the compiler, a syncback
run, a hook.\
_Avoid_: child, job, task

**Service**:\
A worker that runs for as long as its part (Rojo, the watch-mode compiler). Its
exit stops only its part, which is then failed.\
_Avoid_: daemon

**Step**:\
A one-shot unit of work that runs to completion (compile, build, open,
syncback), with its own hooks.\
_Avoid_: task, stage

**Owner pipe**:\
The pipe that ties a `start` process to the parts it owns. Its end of file stops
those parts, and never closes Studio.\
_Avoid_: heartbeat, parent watch

## Builds

**Build**:\
One compile of the watch-mode compiler, from its start line to its summary line,
with its errors and diagnostics. The last one is in the state contract.\
_Avoid_: compile result, rebuild

**Quiet window**:\
The time (750 ms) in which no compile may start before the last build counts as
fresh. A compile that starts in it restarts the wait.\
_Avoid_: debounce, settle time

## Ownership and cleanup

**Lease**:\
The reaper's shared lock on the session's lease file. While any holder lives,
the session's workers may still be alive.\
_Avoid_: lock (alone), pid file

**Marker**:\
Environment variables that tag every worker and its descendants with the session
id and the worker id.\
_Avoid_: tag, label

**Barrier**:\
The check that a session's workers (and supervisor) are verifiably gone: the
lease is free and a scan finds no process of the session.\
_Avoid_: wait, join

**Forced cleanup**:\
The last escalation: kill every process of a session that the barrier still
finds, each pinned and verified as the session's own first.\
_Avoid_: kill all, reset

**Singleton lock**:\
The exclusive lock a supervisor holds for its whole life. At most one session
runs per project.\
_Avoid_: session lock

**Identity record**:\
The write-once record of a session's supervisor: PID, OS start time, session id,
endpoint, version.\
_Avoid_: pid file

**Pin**:\
A handle on a process that proves its identity (PID plus start time), so a
reused PID is never killed.\
_Avoid_: handle (alone)

## Studio

**Lock file**:\
`<place>.lock`, which Roblox Studio keeps next to a place while it has the place
open. It names Studio's PID and computer.\
_Avoid_: place lock, Studio lock

**Auto-recovery file**:\
`<place>_AutoRecovery_<n>.rbxl` in Studio's AutoSaves folder. Studio deletes it
only when it closes by itself; forge handles the ones of a Studio it ended.\
_Avoid_: autosave, backup

**Attach**:\
To add a Studio, with its Rojo, to a running session as parts. A Studio that
already has the place open is attached as it is, never opened a second time.\
_Avoid_: connect, join

**Snapshot**:\
A copy of the place that `forge open` builds and opens, outside every session
and with no Rojo. forge keeps the newest five.\
_Avoid_: one-shot place, temp place

## Control

**Endpoint**:\
The session's control channel: a named pipe on Windows, a Unix socket elsewhere.
One per project root and build output.\
_Avoid_: port, server

**Token**:\
The random secret in the session directory that a client must send first on the
endpoint.\
_Avoid_: password, key

**State contract**:\
The shape of a session's status (`forge status --json`, `state.json`): phase,
each part's status (`off`, `starting`, `ready`, `failed`) and owner, last build,
last syncback run.\
_Avoid_: status file

## Hooks

**Hook**:\
A shell command from the config that runs before (`pre`) or after (`post`) one
forge command's step.\
_Avoid_: script, npm script, task

**Hook stack**:\
The hook ids that run above a forge run, inherited through the environment. It
stops hook cycles.\
_Avoid_: call stack
