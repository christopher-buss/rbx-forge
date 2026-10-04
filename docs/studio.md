# Studio

How `open`, `start`, `up --studio`, and `restart` open Roblox Studio, how
`stop`, `down`, and `restart` close it, and what forge does with Studio's
auto-recovery files.

## Opening Studio

`start` and `up --studio` start Rojo and wait until it listens before launching
a new Studio. If Rojo fails to listen, forge reports its failure and launches no
Studio. A Studio that already has the place open is attached as before.

`open`, `start`, and `up --studio` start the Studio executable directly. A new
session Studio uses `--task RunScript --localPlaceFile <place> --runScriptFile
<script>` to create a non-archivable `ROJO_OPEN_<UserId>` configuration under
`game`. Its attributes identify the session's Rojo host, port, session id, and
worktree project name, plus a temporary loopback readiness callback. Forge checks
that Rojo serves the generated wrapper before writing the script. The managed
plugin consumes the marker and connects without a confirmation dialog. A snapshot
opens with the place as its only argument, as a double-click on the place does.
Studio runs outside every process group and job of forge, so it outlives forge. The session
records the Studio process's PID and start time, so `stop` and `down` can verify
it later. forge finds the executable in this order:

1. `--studio-path <path>` (`open`, `start`, `up --studio`).
2. The `RBX_FORGE_STUDIO_PATH` environment variable (empty means unset).
3. Windows: the command that opens `roblox-studio:` links
   (`HKCU\Software\Classes\roblox-studio\shell\open\command`), then the command
   that opens `.rbxl` files (`HKCU\Software\Classes\Roblox.Place`).
4. macOS: `/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio`.

A path from 1 or 2 that is not a file fails with `studio_launch_failed`.

When forge finds no executable, or the terminal's job forbids breakaway
(Windows), it opens the place through the platform launcher (`start`, `open`,
`xdg-open`). The session then has no PID for Studio, and finds it only through
the place's lock file. The platform launcher passes no marker script.

`open` builds a snapshot, a copy of the place, into
`.forge/snapshots/<time>_<place>` and opens it, with no session and no Rojo. A
running session changes nothing: `open` never opens the session's place, so two
Studios never share one place file. `open` keeps the five newest snapshots, and
every snapshot that has a lock file (a Studio has it open). A snapshot is a
normal place file: `forge syncback --input <snapshot>` syncs changes made in it
back into the project.

`start` and `up --studio` attach a Studio that already has the place open, as
after Ctrl+C on `start`: when the place's lock file names a Studio that `stop`
would verify (see [Closing Studio](#closing-studio)), the session records that
Studio, builds nothing into the place, and opens no second Studio. Studio has
closed the place when the lock file goes or names another process. For a Studio
that a `start` owns, nothing then stops; for a Studio with no owner, only its
Rojo stops. The end of `start` never closes Studio: a Studio it opened leaves
the session and stays open.

A Studio that the session attached this way is a found Studio:
`data.services.studio.origin` is `found` (`forge` for a Studio the session
opened), also after a `start` took it and gave it back. Only `stop --force` and
`restart --force` close a found Studio. `down` and the idle timeout stop its
Rojo and let it go, open, and touch none of its auto-recovery files; `restart`
keeps it, and starts the compiler and Rojo again on the same port; `stop` fails
with `studio_found`.

## Hidden desktop

On Windows, `forge up --studio` opens a new Studio on a hidden desktop, apart
from the user's desktop. It loads plugins and serves the Studio MCP without
changing the user's screen. All projects share one named desktop in the Windows
user session. Forge opens it or makes it and keeps it for later launches.

`forge start` opens Studio on the user's desktop by default. Set
`studio.desktop` in the config or pass `--desktop user` / `--desktop hidden` to
`start` or `up --studio`; the flag wins. On macOS and Linux the effective desktop
is always `user`. A found Studio stays on its existing desktop.

`forge status --json` records the actual desktop as
`services.studio.desktop`. `stop` and `down` close windows on that desktop and
end a Studio blocked by a modal dialog there at once.

## Managed Rojo plugin

After a successful place build, immediately before attempting a new direct
session launch, forge prepares `RojoManagedPlugin.rbxm` in the Studio Plugins
folder. Windows uses `%USERPROFILE%\AppData\Local\Roblox\Plugins`; macOS uses
`~/Documents/Roblox/Plugins`. A missing managed plugin is installed with the
project's Rojo command. Forge supports Rojo 7.7 and later; the recognized stock
sources of 7.7.0 and 7.7.1 share one patch. Unknown or manually edited sources,
unreadable sources, and newer forge patches are preserved with manual connection
guidance. Upstream launch-marker support is preserved too; its confirmation
dialog may still need accepting in Studio.

Both script sources are replaced atomically. A current coherent pair is left
alone, because writing the file can reload the plugin in an open Studio. The
patch connects only when the server's project name and initial session id match
the launch marker. It accepts that project's initial patch and renames `game`
to the wrapper name, as stock Rojo does. A plugin/server protocol mismatch fails with
`plugin_protocol_mismatch` (exit 7); an atomic write failure uses
`plugin_write_failed` (exit 8).

After an unexpected disconnect, the patch keeps the launch marker's host, port,
and worktree project name and polls that same address every second. A restarted
Rojo with the expected project name reconnects without a dialog, using its fresh
session id; initial synchronization includes edits made while Rojo was down. A
different project is refused before any data applies, with one notice per server
session id while polling continues. Editing the widget's address does not retarget
this reconnect. A manual Disconnect stops polling, including during downtime or
a pending request.

The patch is on by default, with no config option or restore command. Run the
project's `rojo plugin install` to restore the stock plugin. Creator Store
plugins are outside this managed file and are not patched. Existing attached
Studios, `forge open` snapshots, and launches with no discoverable executable
do not prepare the plugin. If Windows denies breakaway after the direct launch
attempt, the plugin may already be prepared; the platform fallback receives no
marker and needs manual connection.

Sessions serve only their generated `.forge/sessions/<id>/rojo.project.json`
wrapper, which names the worktree and points at the original project with
`$path`. Changes to that project file reload while Rojo runs. The wrapper's name
and root serve fields stay frozen while Rojo runs and are regenerated when Rojo
starts again.

For a managed launch, Studio stays `opening` until its place lock names the
launched process and the plugin acknowledges both completed initial synchronization
and an open synchronization stream. The temporary callback uses a random launch
token and the expected Rojo identity. It closes on success, cancellation, Studio
close, failure, or the readiness deadline. `down` and `stop` remain responsive
while synchronization is pending. If synchronization is not acknowledged before
the deadline, forge reports the failure; a late callback cannot make Studio ready.
The callback certifies only the original launch session. If that connection fails
before acknowledgement, reconnecting to a fresh Rojo session cannot satisfy the
original readiness wait.

An unknown or upstream plugin, an existing Studio, and a platform fallback need
manual connection. Their `open` status confirms only the place lock. The managed
plugin leaves a Studio opened without a launch marker disconnected until a manual
Connect; saved edit-mode endpoints do not connect automatically. Manual controls
and playtest connections retain their stock behavior.

## Closing Studio

`down`, `stop`, and `restart` close Studio the same way. forge sends a close
request, as Studio gets when you close its window (`WM_CLOSE` to its main
windows; `SIGTERM` on macOS and Linux), then looks at Studio every 50 ms:

- When the place's lock file goes, Studio has closed the place: forge ends the
  process at once, instead of waiting for Studio's slow exit.
- When a modal dialog blocks Studio (Windows, or macOS with Accessibility
  access), forge ends it at once, without a
  save. A place fresh from `rojo build` always counts as changed in Studio, so
  "Save changes?" is the common case. Studio also shows a modal dialog while it
  opens a place.
- When Studio is still open after 15 seconds, forge ends it without a save.

After it ends Studio, forge deletes the place's lock file, because an ended
Studio cannot delete it.

forge closes only a Studio it can verify:

- The Studio the session started, when it still runs with its recorded start
  time. If the place has a lock file, the lock file must name the same process.
- Else the Studio that the place's lock file names, after forge verifies that
  the process is that Studio (this computer, the Studio executable, started
  before the lock file).

It never touches another Studio.

`stop` and `down` ask the running session to close its Studio; the session
closes it and stops its Rojo. `stop` falls back to the lock file of the
configured place (or of `--place <path>`) when the session has no Studio of that
place. With no `--place`, `stop` first closes every snapshot Studio: each
snapshot with a lock file, verified as above. When the session reports Studio as
`opening`, a managed synchronization wait does not delay closing a place already
locked by its Studio. While the place has no matching lock, the session waits up
to 60 seconds for the lock, then closes Studio. A session with no part left ends, once a
syncback run for a last save is done. A Studio that a `forge start` terminal
owns stays: `stop` fails with `studio_owned`, and `stop --force` closes it. A
found Studio stays too: `stop` fails with `studio_found`, and `stop --force`
closes it. `--force` does not change how Studio closes.

## Auto-recovery

Studio deletes its auto-recovery files only when it closes by itself. After
forge ends a Studio it verified (a dialog, the time limit, or the kill after the
lock file went), it handles that Studio's auto-recovery files, so the next
launch does not offer to recover a place forge builds anyway:

- `move` (the default): move them to `.forge/recovery/<time>_<file>`, and keep
  the 5 newest there. They are normal place files: open one in Studio to get
  back changes made in Studio.
- `delete`: delete them.
- `keep`: leave them.

Set the mode with [`studio.autoRecovery`](./config.md#studioautorecovery) in the
config, or `--recovery <mode>` on `stop`, `down`, and `restart`; the idle
timeout uses the config's mode. forge acts only when it ended a Studio, and only
on `<place>_AutoRecovery_<n>.rbxl` files (any case) for the place, written since
that Studio started (2 seconds of slack). It searches:

- Windows: `%LOCALAPPDATA%\Roblox\RobloxStudio\AutoSaves` and
  `%USERPROFILE%\Documents\ROBLOX\AutoSaves`.
- macOS: `~/Library/Application Support/Roblox/RobloxStudio/AutoSaves` and
  `~/Documents/ROBLOX/AutoSaves`.

forge tries a busy file again for 5 seconds (Windows can hold the file of a
killed process), and copies and deletes a file on another drive. A failure is a
warning in `recovery.warnings`; it never fails `stop` or `down`.

Limit: two projects with the same place file name, open at the same time, can
match each other's file. `move` keeps the file, so nothing is lost.

## Saving

`forge save` saves the session's Studio, whether forge opened it or found it
already open. It waits while Studio opens, checks that the place is writable,
presses the English File > Save to File menu, and waits for the changed mtime
to settle. `--timeout <s>` controls the wait (30 seconds by default). Session
saves run one at a time and count as activity for the idle timeout.

On Windows, saving Studio on the user's desktop takes focus. The result names
the desktop so an agent can tell whether the user saw the save.

On macOS, forge presses the menu through Accessibility (AX) without activating
Studio. It saves in the background, while minimized, and while the app is hidden;
Studio keeps its focus and visibility. Grant Accessibility access to the terminal
running forge in System Settings > Privacy & Security > Accessibility, then
restart that terminal if needed. forge never prompts for this permission. Menu
names must be English. The writable check runs before any AX action, because a
read-only save can activate Studio and switch Space.

An agent edits through Studio, then runs `forge save --json`, then
`forge syncback --json`. Syncback reads the saved place on disk.

A Studio that is not open fails with `studio_not_open`; a modal before the
request fails with `studio_busy`. `save_failed` carries `details.reason`:
`timeout`, `studio_error`, `no_menu_item`, or `permission_denied`. The writable
check stops a read-only place before Studio can show a save error.
