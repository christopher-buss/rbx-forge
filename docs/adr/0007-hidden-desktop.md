---
status: accepted
---

# Hidden Studio placement

Studio edits (for example, through the Studio MCP) reach disk only after a save,
and syncback reads the saved place. Studio has no API, IPC, command-line switch,
or plugin API that saves a local place, so `forge save` presses File > Save to
File through accessibility: UI Automation on Windows, AX on macOS. On Windows,
expanding File makes Studio the active window, also when its main window is
hidden, and forge cannot give the focus back. A separate desktop prevents this
focus change, but Windows cannot move an existing window between desktop
objects. Session Studios run on the user's desktop with hidden windows, so their
placement permits visibility changes without crossing desktop objects. The
separate hidden desktop serves only hidden snapshots. On macOS, an AX press
saves in the background with no change of focus, so macOS needs no separate
desktop object; but Studio keeps File > Save to File disabled until it has been
the active app once. There, Studio started as a bare process becomes the
frontmost app while it loads; a LaunchServices launch without activation never
does. So on macOS, the hidden desktop is a background LaunchServices launch,
kept hidden, and activated only briefly when a save needs it.

## Decisions

- **Windows hidden session.** Studio launches on the user's desktop with
  `STARTF_USESHOWWINDOW` / `SW_HIDE`, without activation, a taskbar button, or
  an Alt+Tab entry. A detached helper owns the watcher that hides new top-level
  windows of its verified PID while it is hidden, and ends when Studio exits or
  is shown.
- **One hidden snapshot desktop.** One named hidden desktop per Windows user
  session, shared by all projects. forge opens it, or makes it if it does not
  exist, and never destroys it. Only hidden snapshots use it.
- **Defaults.** `up --studio` and `open` launch Studio hidden; `start`, for
  people, launches it on the user's desktop. `studio.desktop` in the config and
  `--desktop <user|hidden>` override this. On Windows, `restart` keeps Studio's
  visibility and the state contract reports it (`services.studio.desktop`). On
  macOS the same defaults and overrides apply; Linux always uses the user's
  desktop.
- **macOS hidden.** forge launches the Studio app bundle through LaunchServices
  as a new instance, with activation off, and hides it as soon as it exists.
  Studio shows itself while it loads, so a detached watcher hides it again each
  time, until the place is open and Studio has stayed hidden for a while. It
  never hides an active Studio. Its windows can appear behind the front app for
  a moment, never focused. The `user` desktop takes the same path with
  activation on.
- **macOS priming save.** When Save to File is disabled, the save remembers the
  frontmost app, activates Studio until the item enables, hides Studio again if
  it was hidden, gives the focus back, and then presses the item. Studio shows
  only for that first save of a never-active Studio, and only briefly: an item
  still disabled after a short priming limit fails the save (`menu_disabled`),
  with visibility and focus restored.
- **Fallback.** When forge cannot launch Studio hidden (no executable, so it
  uses the platform launcher, or breakaway is denied), it opens Studio on the
  user's desktop with a warning. On macOS the platform launcher opens the place
  in the background (`open -g -j`), and forge warns that it cannot keep Studio
  hidden.
- **Windows hidden session save.** Expand File, then invoke Save to File, also
  for hidden windows. Every save briefly shows the File menu and moves keyboard
  focus to Studio until the user clicks elsewhere. The save result reports the
  physical desktop (`user`), while `services.studio.desktop` reports visibility
  (`hidden` or `user`). Agents save only when the user explicitly asks for
  syncback. Saves on the separate hidden snapshot desktop leave the user's focus
  unchanged. On macOS a save keeps focus, apart from a priming save.
- **`show` and `hide`.** Both platforms change the same session Studio in place
  without saving, closing, reopening, or running syncback. Its PID, undo
  history, script tabs, Rojo, owner, and origin stay intact. Windows show
  reveals every top-level window, including hidden modal dialogs, and activates
  Studio; hide preserves keyboard focus and starts the re-hide watcher. Show
  stops that watcher. macOS hides the app in place or unhides and activates it.
  An already requested visibility succeeds unchanged. State records the last
  successful visibility change; native desktop and save results still report the
  physical desktop.
- **Close and block checks see hidden windows.** Closing Studio and finding a
  modal dialog cover hidden session windows on the user's desktop and windows on
  the separate snapshot desktop, so `stop` and `down` end a blocked Studio at
  once.
- **The place stays as the project builds it.** forge dismisses the lighting
  migration dialog in hidden session windows and on the hidden snapshot desktop.
  It does not set `Lighting.Technology`.

## Considered options

- **Move a window between desktop objects.** Rejected: an experiment with
  `SetParent` across desktops fails with an invalid parameter error.
  [Microsoft's Sysinternals Desktops documentation](https://learn.microsoft.com/en-us/sysinternals/downloads/desktops)
  states that Windows provides no way to move a window between desktop objects.
- **Save without expanding File.** Rejected: in real Studio's Qt 5.15 menu UI,
  File has no children while closed in UI Automation's control view, raw view,
  or MSAA, even after a first save. Every save must expand the menu before
  invoking Save to File.
- **Keystroke Ctrl+S.** Rejected: it needs focus too, and it goes to whatever
  window has focus.
- **Save, then give the focus back.** Rejected on Windows: Windows refuses
  `SetForegroundWindow`, and the previous window only flashes. macOS gives the
  focus back, so a priming save uses it there, once per Studio.
- **`SwitchDesktop` to the hidden desktop.** Rejected: the hidden desktop has no
  taskbar and no Alt+Tab, so only forge can bring the user back.
- **A plugin that serializes the DataModel.** Rejected: it loses service
  properties and Terrain.
- **Direct spawn on macOS, then hide.** Rejected: a Cocoa app started as a bare
  process activates, so Studio takes focus before forge can hide it.
- **`OpenConfiguration.hides`.** Rejected: Studio ignores it.
- **A Studio on the hidden desktop only.** Rejected: people use Studio from
  `start`, and they must be able to save a visible Studio too.

## Consequences

- The addon provides hidden Windows launch on the user's desktop, verified-PID
  window visibility changes (hide, show without activation, show and activate),
  and a re-hide watcher. Save, close, and dialog checks cover hidden windows and
  the snapshot desktop. macOS uses a LaunchServices launch.
- The macOS watcher's polling interval and quiet window, and the priming save's
  polling interval and limit, are a tuning surface.
- Each Windows hidden session save briefly shows the File menu and moves focus.
  A never-active hidden macOS Studio shows and takes focus briefly on its first
  save.
- A hidden Studio is visible only through `forge status`, `forge show`, and the
  Studio MCP. No tray icon and no toast tell the user that it runs.
- A snapshot launch on the hidden desktop takes longer to reach the place lock
  than a visible launch; the cause is not known. The launch deadline still
  covers it.
- Menu names are English only, so the save fails on a Studio in another
  language.
