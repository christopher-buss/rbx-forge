# Studio

How `open`, `start`, and `up --studio` open Roblox Studio, how `stop` and `down`
close it, and what forge does with Studio's auto-recovery files.

## Opening Studio

`open`, `start`, and `up --studio` start the Studio executable directly, with
the place as its only argument, as a double-click on the place does. Studio runs
outside every process group and job of forge, so it outlives forge. The session
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
the place's lock file.

`start` and `up --studio` attach a Studio that already has the place open, as
after Ctrl+C on `start`: when the place's lock file names a Studio that `stop`
would verify (see [Closing Studio](#closing-studio)), the session records that
Studio, builds nothing into the place, and opens no second Studio. Studio has
closed the place when the lock file goes or names another process. The session
of `start` then ends; for a Studio that `up --studio` attached, only its Rojo
stops.

## Closing Studio

`down` and `stop` close Studio the same way. forge sends a close request, as
Studio gets when you close its window (`WM_CLOSE` to its main windows; `SIGTERM`
on macOS and Linux), then looks at Studio every 50 ms:

- When the place's lock file goes, Studio has closed the place: forge ends the
  process at once, instead of waiting for Studio's slow exit.
- When a modal dialog blocks Studio (Windows), forge ends it at once, without a
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

`stop` asks the running session for its Studio, and falls back to the lock file
of the configured place. When the session reports Studio as `opening` (started,
the place not open yet), `stop` and `down` wait up to 60 seconds for it to be
`open`, then close it. When `down` closes Studio, the session ends by itself
once a syncback run for a last save is done. `--force` does not change how
Studio closes.

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
config, or `--recovery <mode>` on `stop` and `down`. forge acts only when it
ended a Studio, and only on `<place>_AutoRecovery_<n>.rbxl` files (any case) for
the place, written since that Studio started (2 seconds of slack). It searches:

- Windows: `%LOCALAPPDATA%\Roblox\RobloxStudio\AutoSaves` and
  `%USERPROFILE%\Documents\ROBLOX\AutoSaves`.
- macOS: `~/Library/Application Support/Roblox/RobloxStudio/AutoSaves` and
  `~/Documents/ROBLOX/AutoSaves`.

forge tries a busy file again for 5 seconds (Windows can hold the file of a
killed process), and copies and deletes a file on another drive. A failure is a
warning in `recovery.warnings`; it never fails `stop` or `down`.

Limit: two projects with the same place file name, open at the same time, can
match each other's file. `move` keeps the file, so nothing is lost.
