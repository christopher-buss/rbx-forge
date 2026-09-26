---
status: accepted
---

# Part ownership and the idle timeout

AI agents run sessions in many worktrees at once. An agent needs only the
watch-mode compiler for its red-green loop; Studio and Rojo are for checks. An
agent can forget `down`, and a human can share a worktree with an agent. So a
session is a set of parts (the compiler, Rojo, Studio), each part has an owner
or none, and parts with no owner stop after an idle timeout. forge cannot tell a
human command from an agent command; the only caller it can identify is the
`start` process, through its owner pipe. So ownership follows the command, not
the caller: `start` owns, `up` does not.

## Decisions

- **Parts.** A session has zero or more parts: the compiler, Rojo, and Studio.
  Rojo runs only together with a live Studio. A session with no part is valid:
  an agent on a Luau project with no watch command follows the same path.
- **Owners.** A part has one owner, the `start` terminal, or none. Only the
  owner stops an owned part (Ctrl+C or a closed terminal). `down`, `stop`,
  `restart`, and the idle timeout act only on parts with no owner;
  `stop --force` and `restart --force` also act on owned parts. `down` never
  fails because of ownership: it reports what it stopped.
- **`up` adds.** `up` starts the compiler, and `up --studio` also attaches
  Studio and Rojo. A second `up` starts only the parts that are missing or
  failed, and never removes one. Parts that `up` starts have no owner.
- **`start` takes control.** `start` joins a running session over its endpoint,
  takes ownership of every running part, and adds Studio and Rojo (`--no-open`:
  it takes and adds only the compiler). It holds that connection as the owner
  pipe of a session it starts. One `start` owns a session at a time; another
  fails with `session_running`. On Ctrl+C it stops the parts it added and gives
  back the parts it took; those keep running with no owner. A session with no
  part left ends.
- **Studio outlives Ctrl+C.** The end of the owner pipe never closes Studio. A
  Studio that `start` opened stays open and leaves the session. The close of a
  Studio that `start` owns stops nothing. `start`, `up --studio`, and `restart`
  attach a Studio that already has the place open (after the identity check of
  `stop`) and never open a second one.
- **A part fails alone.** A service's exit stops only its part, which is then
  `failed`. Nothing restarts it by itself. `up`, `start`, or `restart` starts it
  again: the compiler first, then Rojo, which needs the compiler's output. When
  an attached Studio with no owner closes, only its Rojo stops.
- **Idle timeout.** Activity is a client request, a compile start, or a Studio
  save. After `session.idleTimeout` minutes (default 30, 0 turns it off) with no
  activity, the session stops its parts with no owner, Studio included (its
  auto-recovery files are handled as for `stop`). An `up` session with no parts
  left ends.
- **One compiler.** `forge compile` never compiles while a session runs; it
  waits for the session's fresh build, as `status --wait` does.
- **`open` is outside sessions.** `forge open` builds a snapshot into
  `.forge/snapshots/` (the newest five stay) and opens it with no Rojo. It never
  shares the place file with a session's Studio. A live Studio comes only from
  `start` or `up --studio`.
- **Rojo port.** A `rojoPort` in the config is fixed, and a busy port fails.
  With none, forge tries 34872, then takes a free port. A restart of Rojo keeps
  its port.

## Considered options

- **Holders.** `up --holder <pid>` pins the agent's process; the session stops
  when every holder has exited. Rejected: the desktop app keeps a chat's process
  alive for days, so a forgotten chat keeps its session; and a chat closed for a
  moment would close its Studio.
- **Claude Code hooks.** `SessionStart` runs `up`, `SessionEnd` runs `down`.
  Rejected: every chat would start a compiler, also chats that never edit code;
  `SessionEnd` has a 1.5 s budget by default and does not run on a crash; and it
  ties forge to one agent host.
- **`open` attaches to a running session.** Rejected: one command would do two
  things, depending on a state the user cannot see, and a Studio opened only to
  look would have no owner.
- **A `--no-rojo` flag.** Rejected: Rojo exists only with a live Studio, so the
  flag has no case left.
- **Automatic restart of a crashed service.** Deferred (#51): a missing
  `node_modules` or a deleted output folder crashes both services, and Rojo
  cannot start before the compiler has built.

## Consequences

- The state contract gets an owner and a `failed` status for each part, and
  `off` ↔ `starting` transitions. The phase no longer needs Rojo to be ready.
- The supervisor gets an IPC request to add parts and a path to stop one part
  without ending the session; the reaper's admission already stays open until
  shutdown (ADR 0002).
- `start` must connect as the owner of a supervisor that already runs, not only
  of one it spawned.
- An agent that disobeys its skill and uses `--force` can still close a human's
  Studio. The auto-recovery files are the safety net.
