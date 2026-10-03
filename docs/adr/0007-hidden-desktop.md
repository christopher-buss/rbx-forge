---
status: accepted
---

# Studio on a hidden desktop

Studio edits (for example, through the Studio MCP) reach disk only after a save,
and syncback reads the saved place. Studio has no API, IPC, command-line switch,
or plugin API that saves a local place, so `forge save` presses File > Save to
File through accessibility: UI Automation on Windows, AX on macOS. On Windows,
every UI Automation action makes Studio the active window, also when it is
minimised or behind other windows, and forge cannot give the focus back. So on
Windows, forge runs the Studios of agents on a hidden desktop that it makes. A
Studio there starts, loads plugins, saves, and serves the Studio MCP, and
nothing changes on the user's screen. On macOS, an AX press saves in the
background with no change of focus, so macOS needs no hidden desktop.

## Decisions

- **One hidden desktop.** One named hidden desktop per Windows user session,
  shared by all projects. forge opens it, or makes it if it does not exist, and
  never destroys it.
- **Defaults.** `up --studio` and `open` launch Studio on the hidden desktop;
  `start`, for people, launches it on the user's desktop. `studio.desktop` in
  the config and `--desktop <user|hidden>` override this. `restart` keeps
  Studio's desktop. The state contract reports it (`services.studio.desktop`).
- **Fallback.** When forge cannot launch on the hidden desktop (no executable,
  so it uses the platform launcher, or breakaway is denied), it opens Studio on
  the user's desktop with a warning.
- **A visible save is allowed.** `forge save` also saves a Studio on the user's
  desktop. On Windows it takes focus there, with no opt-in; the result reports
  the desktop.
- **`show` and `hide`.** On Windows, `forge show` and `forge hide` save Studio,
  close it, and open it again on the other desktop. Undo history and open script
  tabs are lost. On macOS, they hide and unhide the app.
- **Close and block checks see the hidden desktop.** Closing Studio and finding
  a modal dialog enumerate the windows of Studio's desktop, so `stop` and `down`
  end a blocked Studio at once, as on the user's desktop.
- **The place stays as the project builds it.** forge dismisses the lighting
  migration dialog on the hidden desktop. It does not set `Lighting.Technology`.

## Considered options

- **Keystroke Ctrl+S.** Rejected: it needs focus too, and it goes to whatever
  window has focus.
- **Save, then give the focus back.** Rejected: Windows refuses
  `SetForegroundWindow`, and the previous window only flashes.
- **`SwitchDesktop` to the hidden desktop.** Rejected: the hidden desktop has no
  taskbar and no Alt+Tab, so only forge can bring the user back.
- **A plugin that serializes the DataModel.** Rejected: it loses service
  properties and Terrain.
- **A Studio on the hidden desktop only.** Rejected: people use Studio from
  `start`, and they must be able to save a visible Studio too.

## Consequences

- The addon gets a desktop option for detached launch, a save request, and a
  dialog dismissal, each able to act on the hidden desktop.
- A hidden Studio is visible only through `forge status`, `forge show`, and the
  Studio MCP. No tray icon and no toast tell the user that it runs.
- A launch on the hidden desktop takes longer to reach the place lock than a
  visible launch; the cause is not known. The launch deadline still covers it.
- Menu names are English only, so the save fails on a Studio in another
  language.
