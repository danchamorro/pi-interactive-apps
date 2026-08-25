# Pi Interactive Apps

Run `btop`, `lazygit`, or any other terminal app inside Pi, leave it running, and come back to it later. Apps keep running when you detach, reload Pi, or quit Pi entirely.

It works by keeping every app in a private tmux server (`tmux -L pi-apps`), so it never touches your normal tmux sessions.

## Demo

https://github.com/user-attachments/assets/42f27ce1-8007-4af2-8018-9442ee771af7

## Requirements

- macOS or Linux
- tmux installed and on your `PATH`
- Pi running in interactive TUI mode (`/app` refuses to run in other modes)

## Install

```bash
pi install git:github.com/danchamorro/pi-interactive-apps
```

Run `/reload` if Pi is already open.

Try a local checkout without installing it:

```bash
pi -e /path/to/pi-interactive-apps
```

## Quick start

1. Start an app:

   ```text
   /app lazygit
   ```

   Pi hands the whole terminal to lazygit. Keyboard input goes straight to the app.

2. Press `Ctrl+B`, then `D` to detach. lazygit keeps running. You land in the dashboard.

3. Press `Escape` to return to Pi. The footer now shows `apps 1`.

4. Later, press `Ctrl+Shift+A`, select lazygit, and press `Enter` to jump back in exactly where you left it.

## The three ways to run `/app`

| Command | What it does |
| --- | --- |
| `/app <command>` | Starts the command in the current project and attaches to it right away. |
| `/app` | Opens the dashboard for the current project, without starting anything. |
| `/app --all` | Opens a global dashboard with apps from every project, grouped by directory. |

Press `Ctrl+Shift+A` at any time to open the current project's dashboard without changing text in Pi's editor.

Anything you can type in a shell works, including flags and pipes:

```text
/app npm run dev
/app btop
/app ssh myserver
/app tail -f logs/app.log
```

## The dashboard

`/app` opens a full-screen list. It shows running apps first, then your pinned favorites.

```
  Interactive apps                          2 apps · 1 favorite
╭─ apps · 0 attached / 2 ──────────────────────────────────────╮
│ ❯ ■ lazygit  pi-app-3f2a91c4          4m ago · detached      │
│   ■ btop     pi-app-91be04dd          2h ago · detached      │
│   favorites · 1                                              │
│     ★ npm                                    npm run dev     │
╰──────────────────────────────────────────────────────────────╯
```

Reading a row:

- **Green square** means an app has a terminal attached right now. Grey means detached and waiting.
- **`pi-app-…`** is the app's id, used in confirmation prompts.
- **Right side** shows how long the app has been running and whether it is attached.
- **Star rows** are favorites: saved commands that are not running yet.

Before you have started anything, the same screen looks like this:

```
  Interactive apps                         0 apps · 0 favorites
╭─ apps · 0 attached / 0 ──────────────────────────────────────╮
│   No apps or favorites yet. Press a to add a favorite.       │
│                                                              │
╰──────────────────────────────────────────────────────────────╯
```

### Keys

| Key | Action |
| --- | --- |
| `Up` / `Down`, or `k` / `j` | Move the selection |
| `Enter` | Attach to an app, or start a favorite in this project |
| `a` | Save a new favorite command |
| `x` | Stop the selected app, or remove the selected favorite (asks first) |
| `Escape` | Close the dashboard and return to Pi |
| `Ctrl+B` then `D` | Inside an attached app: detach and leave it running |

The bottom line of the dashboard reminds you of the same thing:

```
  ↑/↓/jk select · ⏎ open · x stop/remove · a add favorite · esc close · inside app: Ctrl+B then D detaches
```

The list refreshes about once a second, so apps that exit on their own disappear while you watch.

The boxes below show what Pi asks you at each step. The exact borders and button styling follow your Pi theme; the wording is what matters.

## Features

### Detach without stopping

`Ctrl+B` then `D` is tmux's detach shortcut. The app keeps running in the background. This is the whole point of the extension: a dev server or a long build does not die because you went back to chatting with Pi.

### Project scoping

`/app` only shows apps started in the current project directory. Symlinked paths are resolved first, so `/Users/you/code/api` and a symlink to it count as the same project.

Use `/app --all` when you want everything. That view groups apps under their project directory and lets you attach to or stop apps belonging to other projects:

```
  Interactive apps                    3 apps across 2 projects
╭─ apps · 1 attached / 3 ──────────────────────────────────────╮
│   /Users/you/code/api                                        │
│ ❯ ■ npm       pi-app-3f2a91c4        12m ago · attached      │
│   ■ tail      pi-app-77c1a0b2         1h ago · detached      │
│   /Users/you/code/web                                        │
│   ■ btop      pi-app-91be04dd         2h ago · detached      │
╰──────────────────────────────────────────────────────────────╯
```

The global view has no favorites section and no `a` key, because a favorite always starts in the project you are currently in.

### Favorites

Favorites are commands you start often. Press `a` in the project dashboard and Pi asks for a command:

```
╭─ Add favorite ─────────────────────────────────╮
│ Command to run in the current project          │
│                                                │
│ › npm run dev                                  │
╰────────────────────────────────────────────────╯
```

It asks for a **command, not a name.** The name in the list is taken from the first word of the command, so `npm run dev` is shown as `npm` with the full command on the right:

```
│   favorites · 1                                              │
│     ★ npm                                    npm run dev     │
```

That means `npm run dev` and `npm run build` both show as `npm`. The command text on the right is what tells them apart.

Select a favorite and press `Enter` to start it in whatever project you are currently in. Press `x` to remove it, and Pi checks first:

```
╭─ Remove favorite ──────────────────────────────╮
│ Remove "npm run dev" from favorites?           │
│                                                │
│                        Yes        No           │
╰────────────────────────────────────────────────╯
```

Favorites are shared across all your projects, not per project. That is deliberate: `npm run dev` is useful in many repositories.

They are stored in `$PI_CODING_AGENT_DIR/interactive-apps.json`, or `~/.pi/agent/interactive-apps.json` when that variable is not set.

### Footer status

Pi's footer shows the current project's app count:

- `apps 2` when two apps are running detached.
- `apps 2 · 1 attached` when one of them has a terminal attached.
- Nothing at all when this project has no apps.

The footer never counts apps from other projects.

### Stopping apps

Press `x` on a running app. Pi names the app and warns you, because stopping it throws away anything unsaved inside it:

```
╭─ Stop app ─────────────────────────────────────╮
│ Stop "lazygit" (pi-app-3f2a91c4)? Unsaved      │
│ work in it will be lost.                       │
│                                                │
│                        Yes        No           │
╰────────────────────────────────────────────────╯
```

In `/app --all` the prompt also names the project, since the app you are about to stop may belong to a different one:

```
│ Stop "btop" (pi-app-91be04dd) in               │
│ /Users/you/code/web? Unsaved work in it will   │
│ be lost.                                       │
```

Answer no and nothing happens; the dashboard reopens with the same row selected.

To stop every managed app in every project:

```bash
tmux -L pi-apps kill-server
```

This does not ask. It can discard unsaved work.

## What survives, what does not

Survives:

- `/reload`
- Switching Pi sessions
- Closing and reopening Pi

Does not survive:

- Rebooting the machine
- `tmux -L pi-apps kill-server`
- The app exiting on its own

If an app dies within a second of starting, Pi reports that it exited immediately, which usually means a typo in the command.

## Messages you might see

| Message | What it means |
| --- | --- |
| `Favorite added.` | The command is now pinned. |
| `Favorite already pinned.` | You already have that exact command saved. |
| `"npm" exited immediately after starting.` | The command failed within a second. Usually a typo or a missing binary. |
| `No interactive apps are running. Start one with /app <command>.` | You opened `/app --all` with nothing running anywhere. |
| `All interactive apps have exited.` | The last app in the global view stopped while you were looking at it. |
| `Interactive apps require Pi's interactive TUI.` | You are not in Pi's interactive terminal mode. |

## Troubleshooting

**"Interactive apps require Pi's interactive TUI."**
You are in a non-TUI mode (headless or print mode). `/app` only works in the interactive terminal UI.

**Nothing happens, or tmux errors appear.**
Check that tmux is installed: `tmux -V`. The extension shells out to the `tmux` binary.

**An app is missing from `/app`.**
It was probably started in a different directory. Try `/app --all`.

**I want to see the raw sessions.**

```bash
tmux -L pi-apps ls
```

## Security notes

- `/app` runs your command through your login shell. It is a user command, not something the model can call.
- The manager stores only encoded project and display metadata in tmux, and removes the full command from the tmux session environment after startup.
- Favorites are different: their full command text is saved in the local favorites file so it can be reused. They run only when you select one and press `Enter`. Do not pin commands that contain secrets.
- Pi packages run with the same system access as Pi. Review extension source before installing it.

## Development

```bash
npm test
```

The test suite has no third-party runtime dependencies.

## License

MIT
