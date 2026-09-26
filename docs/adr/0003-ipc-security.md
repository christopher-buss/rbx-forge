---
status: accepted
---

# IPC: a per-user endpoint, a token, and one request per connection

A running session is controlled through a local endpoint (`status`, `sync`,
`shutdown`). Only the user who started the session may reach it: no other local
user, no remote client. We chose OS access control plus a token instead of a TCP
port, because a TCP port on localhost is open to every local user and to
browsers, and a port number can collide across worktrees.

## Decisions

- **Endpoint per project and build.** The key is
  `sha256(projectRoot + "\0" + buildOutputPath)`, first 16 hex characters. So
  each worktree, and each build output of one tree, has its own session.
- **Windows.** A named pipe `\\.\pipe\rbx-forge-<key>`, created by the native
  addon with an explicit DACL that allows only the current user,
  `PIPE_REJECT_REMOTE_CLIENTS`, and `FILE_FLAG_FIRST_PIPE_INSTANCE`. The libuv
  default DACL grants read to Everyone and Anonymous (ADR 0001), so it is not
  used. Clients connect through the addon too (`connectPipe`: bounded
  `WaitNamedPipeW`, `SECURITY_IDENTIFICATION`), because `node:net` waits 30 s
  per busy pipe on a libuv thread and keeps the process alive.
- **POSIX.** A Unix socket `ctl.sock` (mode 0600) in a directory
  `rbx-forge-<uid>-<key>` (mode 0700, owned by the user) under
  `XDG_RUNTIME_DIR`, else `TMPDIR`, else `/tmp`. A path longer than 103 bytes
  (the macOS `sun_path` limit) falls back to `/tmp`. Only the singleton lock
  holder removes a stale socket.
- **Token.** A random UUID in `.forge/sessions/<id>/token`, written once: mode
  0600 on POSIX, an owner-only DACL on Windows (native `writePrivateFile`). The
  first line on a connection is `{"type":"hello","protocol":1,"token":…}`. A
  wrong token or protocol closes the connection with no answer.
- **One request per connection.** Hello, one request line, one response line,
  close. No streaming: `logs` reads the log files, and `up` and `start` read
  status and report files. Every wait is bounded (2 s per read and write; a line
  is at most 1 MiB). `sync` gets a longer answer bound (30 min) because it runs
  syncback and its hooks.

## Consequences

- The tests cover each rule: wrong token rejected, remote-style pipe paths
  rejected (needs the SMB server service on Windows), the pipe DACL has exactly
  one allow entry for the current user, and another local user is denied (the
  `other-user` CI job creates a second user on each OS).
- A directory that is not the user's, or a pipe another process already owns,
  gives `endpoint_in_use`; the session does not start.
