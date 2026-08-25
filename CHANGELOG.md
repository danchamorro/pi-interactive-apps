# Changelog

## 0.3.1 - 2026-08-25

- Open the current project's dashboard with `Ctrl+Shift+A`.

## 0.3.0 - 2026-08-25

- **Breaking:** remove the `/tode` command. Use `/app tode` if you still want it.

- Open the project dashboard when no apps are running.
- Add profile-wide favorite commands that can be pinned, started, and removed from the dashboard.

## 0.2.0 - 2026-08-24

- Add `/app --all`, a global dashboard grouped by canonical project directory.

## 0.1.1 - 2026-08-24

- Add the 25-second demo video and README link.
- Install from the moving `main` package source by default.
- Keep Tode support while shortening the README usage example.

## 0.1.0 - 2026-08-24

- Add project-scoped interactive app sessions on a private tmux server.
- Add `/app` start and dashboard flows.
- Add `/tode` compatibility alias.
- Add detach, reattach, and confirmed stop actions.
- Add current-project footer status with attached-client counts.
- Add canonical cwd filtering and persistent tmux metadata.
- Add manager, dashboard, orchestration, and footer tests.
