# Interactive App Manager Implementation Plan

## Goal
Replace the shared Tode-only terminal handoff with a project-scoped interactive app manager based on the proven `/ps` dashboard model. A user can start any terminal app with `/app <command>`, detach without stopping it, reopen `/app` to select it again, and return to Pi without losing either the app state or the Pi session.

## Agreed decisions
- Base the interaction and component lifecycle on `/ps`: a full-screen picker, stable row selection, Enter to open, `x` to stop, configured selector keys, and Escape to return to Pi.
- Keep `/ps` unchanged and read-only. Interactive apps use a separate manager because `/ps` processes have no stdin and are killed during Pi session shutdown.
- `/app` with no arguments opens the current project's app dashboard.
- `/app <terminal command>` starts the command in the current project, attaches immediately, and opens the dashboard when the user detaches.
- Support arbitrary user-entered terminal commands such as `tode .`, `lazygit`, and `btop`.
- Use a private tmux server named `pi-apps` as the persistence layer. Do not add a PTY library or npm dependency.
- Show only sessions whose canonical working directory matches the current Pi working directory. Sessions from other projects keep running but remain hidden until Pi is opened in their project.
- Use tmux's standard `Ctrl+B`, then `D` detach sequence. Do not intercept Escape inside an attached app.
- Escape closes the `/app` dashboard and returns to Pi.
- Keep `/tode` as a compatibility alias for `/app tode .`.
- Bind `Shift+Ctrl+T` (`ctrl+shift+t` in Pi shortcut syntax) to the `/app` dashboard.
- Keep app sessions alive across Pi `/reload`, session changes, and Pi exit. A machine reboot or explicit tmux termination may end them.
- Require confirmation before killing an app session because an attached editor may contain unsaved work.
- Do not expose an agent tool for starting interactive apps in the first version. `/app` is a user command.

## Scope
### In scope
- A tmux-backed manager for starting, listing, attaching, and terminating interactive app sessions.
- Project filtering by canonical working directory.
- A `/ps`-style full-screen dashboard with live session refresh.
- Safe Pi TUI suspension and restoration around tmux attachment.
- `/app`, `/tode`, and `Shift+Ctrl+T` entry points.
- Automated manager, dashboard, and command-orchestration tests.
- Manual verification with Tode, LazyGit, and btop.
- Shared loading in pi-slim, pi-gsg, and pi-dcit through the existing `./shared` package.

### Out of scope
- Changes to `background-terminals`, `/ps`, `bg_start`, or their read-only process model.
- Capturing interactive app output in the Pi transcript.
- Starting apps through an LLM-callable tool.
- Presets, favorites, command history, or a dashboard form for entering new commands.
- Displaying sessions from other projects in the current project's dashboard.
- Windows support or a non-tmux fallback.
- Restarting apps after a machine reboot.
- Replacing tmux's detach key or taking over Escape inside Tode, LazyGit, btop, or another child app.

## Repository evidence
- `shared/extensions/background-terminals/src/ui/ps.ts`: `openTerminalPicker`, `TerminalDashboard`, `DashboardSelection`, and `reconcileDashboardSelection` provide the proven full-screen overlay, stable selection, configured selector keys, `j`/`k` navigation, Enter action, `x` action, fixed-height rendering, and idempotent timer cleanup to adapt.
- `shared/extensions/background-terminals/ps.test.ts`: demonstrates the smallest existing tests for selection reconciliation, safe one-line terminal text, and width-aware rendering helpers.
- `shared/extensions/background-terminals/src/manager.ts`: starts `/ps` processes with `stdio: ["ignore", "pipe", "pipe"]`; this proves `/ps` cannot attach to interactive stdin and must remain separate.
- `shared/extensions/background-terminals/index.ts`: registers `/ps` and tears its process manager down in `session_shutdown`; the interactive app manager must intentionally avoid that shutdown behavior so tmux sessions survive reload and exit.
- `shared/extensions/tode/index.ts`: already proves Pi can stop its TUI, run a child with inherited stdio, and restart with a forced redraw. The new attach path should retain this `try`/`finally` handoff.
- `shared/extensions/tode/index.test.ts`: already stubs an executable through `PATH` and verifies `stop`, `start`, and forced redraw ordering. Replace this with generic app handoff coverage.
- `shared/extensions/skill-picker/index.ts`: registers a raw `ctrl+shift+k` extension shortcut, confirming the repository pattern to use for `ctrl+shift+t`.
- `profiles/pi-slim/settings.json`, `profiles/pi-gsg/settings.json`, and `profiles/pi-dcit/settings.json`: each loads `./shared`, so one extension under `shared/extensions/` reaches all three personal profiles.
- `profiles/pi-slim/shared`, `profiles/pi-gsg/shared`, and `profiles/pi-dcit/shared`: each is an existing `../../shared` symlink; no installer or settings change is required.
- `install.sh`: only runs dependency restoration for extensions with a lockfile. The app manager can remain dependency-free and does not require installer changes.
- Local runtime verification: `/opt/homebrew/bin/tmux` is version 3.6b, and `tode`, `lazygit`, and `btop` are installed.
- Installed Pi 0.84.3 documentation and `examples/extensions/interactive-shell.ts`: confirm `ctx.ui.custom()`, `tui.stop()`, inherited stdio, `tui.start()`, and forced redraw as the supported interactive handoff pattern. Recent Pi changes also improve full-screen overlay focus, scrolling, mouse handling, and tmux modified-key behavior.

## Implementation phases

### Phase 1: Add the project-filtered tmux app manager
**Objective:** Provide a tested synchronous manager and read model that mirrors `/ps` manager semantics while using a private tmux server for persistent interactive sessions.

**Dependencies:** None

**Files likely affected:**
- `shared/extensions/interactive-apps/src/manager.ts`: add the tmux command runner, `AppSession` snapshot type, project filter, start/list/kill operations, and synchronous read-model subscription contract used by the dashboard.
- `shared/extensions/interactive-apps/manager.test.ts`: add fake-runner tests for tmux commands, metadata, filtering, errors, and lifecycle behavior.

**Tasks:**
- [x] Define an `AppSession` snapshot containing a generated safe id, display label, canonical cwd, tmux creation time, and attached-client count. Do not retain the full command in dashboard metadata.
- [x] Canonicalize `ctx.cwd` before storing or comparing project identity so symlink aliases resolve to the same project.
- [x] Address the private tmux server as `tmux -L pi-apps` and generate collision-resistant session names with a fixed `pi-app-` prefix.
- [x] Start the user command through the user's shell in the requested cwd without concatenating it into a management shell command. Pass it through a temporary tmux session environment value. The constant wrapper must copy the command into a shell variable, unset the temporary command and shell environment values before launching `shell -lc`, and remove those values from the tmux session environment after pane creation.
- [x] Derive a short one-line display label from the leading executable token, strip path prefixes and control characters, and give duplicate sessions distinct ids. Do not store the full user command in tmux user options.
- [x] Store only encoded manager metadata such as canonical cwd and display label in tmux session user options, then decode it when listing sessions.
- [x] Configure the private tmux server idempotently for extended keys using the installed tmux 3.6 support and show a concise status-bar hint for `Ctrl+B D` detach.
- [x] List only manager-owned sessions whose decoded canonical cwd equals the current canonical cwd. Treat tmux's expected "no server running" response as an empty list, not an error.
- [x] Expose a synchronous read model patterned after `/ps`, with `list`, `get`, `size`, `subscribe`, refresh, and kill requests. Polling and UI code must read snapshots rather than invoke tmux during `render()`.
- [x] Kill only a selected manager-owned session. Reject malformed or unknown ids rather than forwarding them to tmux.
- [x] Return clear errors for missing tmux, failed session creation, metadata setup failure, list failure, attach race, and kill failure.
- [x] Do not register `session_shutdown` cleanup. Tmux remains the source of truth after Pi reloads or exits.
- [x] Test two projects with canonical paths: sessions from project A appear only in project A, sessions from project B appear only in project B, and both remain managed by the same private server.
- [x] Test that management commands always include `-L pi-apps`, use generated session ids, pass cwd separately, remove temporary command environment state, and never include the full command in persistent tmux options.
- [x] Test no-server, missing-binary, malformed metadata, vanished-session, kill, and nonzero tmux outcomes.

**Acceptance criteria:**
- Starting `btop` for project A produces one manager-owned tmux session discoverable from project A and absent from project B.
- Listing with no private tmux server returns an empty array.
- A started session remains discoverable after constructing a fresh manager instance.
- Killing a known session removes it from the next refreshed snapshot.
- The full command is not present in persistent tmux user options after startup.
- A normal user tmux server and its sessions are never listed or changed.

**Validation:**
- `cd /Users/danielchamorro/Documents/Personal/pi-profiles/shared/extensions/interactive-apps && node --test --experimental-strip-types manager.test.ts`

**Suggested commit:** `feat(apps): add project-filtered tmux session manager`

### Phase 2: Add the `/ps`-style app dashboard and terminal handoff
**Objective:** Deliver the user-facing `/app` workflow, compatibility alias, shortcut, safe attach loop, and app termination confirmation.

**Dependencies:** Phase 1

**Files likely affected:**
- `shared/extensions/interactive-apps/index.ts`: register commands and shortcut, coordinate start, attach, dashboard re-entry, mode guards, and notifications.
- `shared/extensions/interactive-apps/src/ui/apps.ts`: add the full-screen dashboard based on `TerminalDashboard` and `openTerminalPicker` from `/ps`.
- `shared/extensions/interactive-apps/app.test.ts`: test selection, rendering, navigation actions, polling cleanup, and kill action results.
- `shared/extensions/interactive-apps/index.test.ts`: test command registration, aliasing, shortcut behavior, start/attach flow, TUI restoration, and failure handling.
- `shared/extensions/tode/index.ts`: remove after `/tode` delegates through the generic extension.
- `shared/extensions/tode/index.test.ts`: remove after equivalent compatibility and handoff tests exist in the generic extension.

**Tasks:**
- [x] Adapt the `/ps` picker loop, full-screen `100%` overlay, fixed-height layout, configured selector key handling, `j`/`k` aliases, stable id-based selection, one-line sanitization, truncation, and idempotent `dispose()` cleanup. Keep the implementation local to the app extension rather than refactoring `/ps` during this change.
- [x] Render current-project app rows with label, age, attached state, and dim session id. Include controls for selection, attach, stop, close, and the `Ctrl+B D` detach instruction.
- [x] Refresh manager snapshots on a bounded one-second timer while the dashboard is open, request a redraw only after snapshot changes, and stop the timer when the component closes or is disposed.
- [x] Make Enter return an attach action to the command orchestrator. Stop Pi's TUI, clear the screen, run `tmux -L pi-apps attach-session -t <validated-id>` with inherited stdio, and always restart and force-redraw Pi in `finally`.
- [x] Reopen the dashboard after tmux detaches. If the app exited and no current-project sessions remain, notify the user and return to Pi rather than leaving an empty selector.
- [x] Make `x` return a stop action to the orchestrator. Close the overlay, ask `ctx.ui.confirm()` with an unsaved-work warning, kill only after confirmation, then reopen the dashboard with stable selection.
- [x] Register `/app`: no arguments open the dashboard; nonblank arguments start the command in `ctx.cwd`, attach immediately, and enter the dashboard loop after detach.
- [x] Treat empty or whitespace-only arguments as the no-argument dashboard form. Reject commands containing a NUL byte with a clear notification.
- [x] Register `/tode` as a compatibility alias that invokes the same path with `tode .`; do not keep separate Tode process handling.
- [x] Register `ctrl+shift+t` to open the current project's dashboard. If Pi is not idle, show a notification instead of replacing active streaming UI.
- [x] Guard all entry points with `ctx.mode === "tui"`; in RPC, JSON, and print modes, report that interactive apps require Pi's TUI and do not start tmux.
- [x] Preserve the existing handoff guarantee on success, attach failure, thrown spawn error, and child nonzero exit: Pi restarts once and receives a forced redraw.
- [x] Test `/app` and `/tode` registration, `ctrl+shift+t`, TUI mode rejection, command forwarding, alias forwarding, attach re-entry, empty dashboard behavior, confirmed and cancelled stop actions, attach races, and TUI restoration.
- [x] Test dashboard selection after sessions are added, removed, reordered, or filtered, plus narrow-width rendering and timer cleanup.
- [x] Remove the old `shared/extensions/tode/` directory only after the generic extension tests cover `/tode` and the inherited-stdio handoff.

**Acceptance criteria:**
- `/app btop` opens btop in the current project. `Ctrl+B D` returns to the dashboard, and Enter reattaches to the same live btop process.
- `/app lazygit` and `/app tode .` can run together and appear as separate rows in the same project's dashboard.
- `/app` from another project does not show those rows.
- `/tode` behaves as `/app tode .`.
- `Shift+Ctrl+T` opens the current project's dashboard when Pi is idle.
- Escape closes only the dashboard. Escape remains owned by the child app while attached.
- Pressing `x` does not kill an app until the user confirms the unsaved-work warning.
- Detaching, `/reload`, quitting Pi, and reopening Pi in the same cwd leave tmux app sessions available.
- An attach or tmux failure restores Pi's TUI and reports the failure without leaving the terminal in raw mode.

**Validation:**
- `cd /Users/danielchamorro/Documents/Personal/pi-profiles/shared/extensions/interactive-apps && node --test --experimental-strip-types manager.test.ts app.test.ts index.test.ts`
- `cd /Users/danielchamorro/Documents/Personal/pi-profiles/shared/extensions/background-terminals && npm test`
- Manual in pi-slim: run `/reload`, `/app btop`, detach with `Ctrl+B D`, reattach with Enter, detach, press `x`, cancel once, then confirm and verify the row disappears.
- Manual in one Git project: start `/app lazygit` and `/app tode .`, detach from each, and verify `/app` lists both.
- Manual in a different cwd: verify `/app` does not list the first project's apps; return to the first cwd and verify both are still listed.
- Manual persistence: leave one app detached, quit Pi, reopen Pi in the same cwd, and verify `/app` reattaches to the same session.
- Manual isolation: verify `tmux ls` does not show manager sessions while `tmux -L pi-apps list-sessions` does.
- Manual shared rollout: run `/reload` in pi-slim, pi-gsg, and pi-dcit and verify `/app` appears in command completion without profile-specific copies.

**Suggested commit:** `feat(apps): add persistent interactive app dashboard`

### Follow-up: Add a footer indicator
**Objective:** Keep current-project app activity visible without opening `/app`.

**Tasks:**
- [x] Register an `interactive-apps` footer status on `session_start` using Pi's native `ctx.ui.setStatus()` API.
- [x] Show `apps <count>` and append `<attached> attached` when a tmux client is attached.
- [x] Hide the status when the current project has no managed apps.
- [x] Refresh from the private tmux server every two seconds and stop the timer on `session_shutdown` without touching tmux sessions.
- [x] Test initial display, attached-client counts, zero-app clearing, polling, and timer cleanup.

**Validation:**
- `node --test --experimental-strip-types manager.test.ts app.test.ts index.test.ts` passes with 38 tests.
- `git diff --check -- shared/extensions/interactive-apps` reports no whitespace errors.

### Phase 3: Publish and install as a standalone Pi package
**Objective:** Make the app manager a versioned package with one source repository for every personal and Bridge profile.

**Tasks:**
- [x] Create `/Users/danielchamorro/Documents/Personal/Code/my-projects/pi-interactive-apps` with the tested extension, tests, package manifest, README, changelog, MIT license, and this plan.
- [x] Run the complete 38-test suite and repository checks in the package repository.
- [x] Create the public `danchamorro/pi-interactive-apps` GitHub repository and publish the initial `v0.1.0` release.
- [x] Publish `v0.1.1` from current `main` with the demo and corrected install source, mark it as the latest release, and leave `v0.1.0` immutable.
- [x] Install `git:github.com/danchamorro/pi-interactive-apps` in pi-slim, pi-gsg, pi-dcit, and pi-bridge.
- [x] Remove the duplicate `shared/extensions/interactive-apps/` copy after all four package installs succeed.
- [x] Add the 25-second demo video to the package repository and README.
- [x] Verify profile settings, installed package clones, tests, and repository diffs without changing unrelated work.

**Recovery:** Remove `git:github.com/danchamorro/pi-interactive-apps` from each affected profile and restore `shared/extensions/interactive-apps/` from commit `e6151f3` plus the footer follow-up changes.

## Parallel execution
- No safe parallelism identified. The dashboard and orchestration depend on the manager snapshot and action contracts from Phase 1.
- Critical path: Phase 1 tmux manager and read model, then Phase 2 dashboard, command orchestration, compatibility migration, and rollout checks.
- Coordination points: `AppSession` fields, canonical project identity, manager subscription behavior, validated session ids, and the attach/kill action result types must be fixed before dashboard and index tests are written.

## Risks and recovery
- tmux sessions intentionally outlive Pi. The dashboard provides confirmed per-session termination. Emergency recovery is `tmux -L pi-apps kill-server`, which stops every managed app in every project and may discard unsaved work.
- `Ctrl+B` is tmux's prefix and may also be useful inside an app such as Tode. `Ctrl+B`, then `Ctrl+B` sends a literal `Ctrl+B` to the child. Keep this trade-off in the dashboard hint or user-facing notification.
- Killing Tode or another editor can discard unsaved work. Require confirmation and name the selected app before `kill-session`.
- A command may exit before metadata is written or before attach begins. Treat the vanished session as a normal race, refresh the dashboard, and notify only when the user needs an explanation.
- A stale or malformed tmux session must not become a shell-injection path. Generate ids internally, validate the fixed prefix, pass tmux arguments as argv, and never concatenate selected ids or cwd into a shell command.
- Arbitrary commands are intentionally interpreted by the user's shell. Keep `/app` user-only so model tool calls cannot start interactive commands without direct user action.
- The repository already contains many unrelated modified and untracked files. Limit implementation, inspection, and any future staging to `shared/extensions/interactive-apps/` and `shared/extensions/tode/`; do not alter or stage unrelated work.
- A machine reboot ends the tmux server. Recovery is to start the apps again with `/app <command>`; durable restart definitions are out of scope.
- If the new extension fails after rollout, remove `shared/extensions/interactive-apps/`, restore `shared/extensions/tode/`, and run `/reload`. The isolated `pi-apps` tmux server can remain alive during rollback or be stopped explicitly after saving work.

## Final verification
- [x] `node --test --experimental-strip-types manager.test.ts app.test.ts index.test.ts` passes in `shared/extensions/interactive-apps/`.
- [ ] `npm test` passes in `shared/extensions/background-terminals/`, confirming `/ps` behavior remains unchanged.
- [ ] `/app`, `/app btop`, `/app lazygit`, `/app tode .`, `/tode`, and `Shift+Ctrl+T` match the acceptance criteria.
- [ ] Detach returns to the dashboard without killing the child, and dashboard Escape returns to Pi.
- [x] Current-project filtering works in two different canonical working directories.
- [x] Confirmed termination removes one selected session; cancelled termination leaves it running.
- [ ] Sessions survive `/reload`, Pi quit, and Pi restart in the same cwd.
- [x] Missing tmux, no private server, vanished sessions, nonzero tmux results, and attach failures produce bounded errors and restore Pi's TUI.
- [x] `tmux ls` remains isolated from `tmux -L pi-apps list-sessions`.
- [ ] pi-slim, pi-gsg, pi-dcit, and pi-bridge load the installed package after `/reload`.
- [x] All four settings files contain exactly one unpinned `git:github.com/danchamorro/pi-interactive-apps` entry, and the old shared copy is absent.
- [x] The package and profile settings pass `git diff --check` without changing unrelated work.
- [x] The package's TypeScript and manifest contain no credential material.

## Implementation notes (2026-08-24)
- Implemented and committed in two commits: `feat(apps): add project-filtered tmux session manager` and `feat(apps): add persistent interactive app dashboard`. 38 automated tests pass.
- tmux 3.6 rejects the `=` exact-match prefix for `set-option`/`set-environment` targets; those commands use the plain manager-generated id (regex-validated), while `kill-session`/`attach-session` keep `=` exact matching.
- The extension uses only `import type` from Pi packages plus local text helpers, so `node --test` runs with zero dependencies outside Pi.
- `npm test` in `shared/extensions/background-terminals` fails on this machine even before this change (`@earendil-works/pi-coding-agent` is not resolvable outside Pi). `background-terminals` was not modified.
- Remaining unchecked final-verification items are the manual in-Pi checks (reload rollout, acceptance flows, persistence across Pi restart).
- Follow-up footer status uses Pi's native extension-status slot. It shows only current-project apps, polls every two seconds, and disappears at zero.
- The standalone package is public at `https://github.com/danchamorro/pi-interactive-apps`. `v0.1.1` is the latest release; `v0.1.0` remains immutable.
- pi-slim, pi-gsg, pi-dcit, and pi-bridge track unpinned `main` at commit `b893acb`; the 38-test suite passes in every installed clone.
- The README links the 25-second `docs/interactive-apps.mp4` demo and omits Tode from the short usage example while retaining `/tode` support.
- The packaged version does not register `ctrl+shift+t`, matching the source state at extraction.
