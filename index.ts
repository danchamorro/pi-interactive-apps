/**
 * Interactive app manager with /app and /tode commands.
 *
 * `/app <command>` starts an arbitrary terminal command inside a private
 * tmux server (`tmux -L pi-apps`) scoped to the current project, attaches
 * immediately, and drops into a /ps-style dashboard after `Ctrl+B D`
 * detaches. `/app` alone opens the dashboard. Sessions intentionally
 * survive Pi reload and exit. The session_shutdown handler stops only the
 * footer poll; it never cleans up tmux sessions.
 */

import { spawnSync } from "node:child_process";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	AppManager,
	AppManagerError,
	type AppSession,
} from "./src/manager.ts";
import {
	AppDashboard,
	type AppAction,
	type DashboardSelection,
} from "./src/ui/apps.ts";

const STATUS_ID = "interactive-apps";
const STATUS_POLL_MS = 2_000;

export function formatAppStatus(
	sessions: ReadonlyArray<Pick<AppSession, "attached">>,
): string | undefined {
	if (sessions.length === 0) return undefined;
	const attached = sessions.filter((session) => session.attached > 0).length;
	return attached > 0
		? `apps ${sessions.length} · ${attached} attached`
		: `apps ${sessions.length}`;
}

function notifyError(ctx: ExtensionContext, error: unknown) {
	const message =
		error instanceof AppManagerError
			? error.message
			: `Interactive apps failed: ${error instanceof Error ? error.message : String(error)}`;
	ctx.ui.notify(message, "error");
}

/** Suspend Pi's TUI, hand the terminal to `tmux attach`, always restore. */
async function attachTo(
	ctx: ExtensionContext,
	manager: AppManager,
	id: string,
): Promise<void> {
	const argv = manager.attachArgs(id);
	const result = await ctx.ui.custom<{
		status: number | null;
		error?: string;
	}>((tui, _theme, _keybindings, done) => {
		tui.stop();
		let outcome: { status: number | null; error?: string } = { status: null };
		try {
			process.stdout.write("\x1b[2J\x1b[H");
			const child = spawnSync("tmux", argv, {
				cwd: ctx.cwd,
				env: process.env,
				stdio: "inherit",
			});
			outcome = { status: child.status, error: child.error?.message };
		} catch (error) {
			outcome.error = error instanceof Error ? error.message : String(error);
		} finally {
			tui.start();
			tui.requestRender(true);
		}
		done(outcome);
		return { render: () => [], invalidate: () => {} };
	});

	if (result?.error) {
		ctx.ui.notify(`Could not attach: ${result.error}`, "error");
	}
	// A nonzero exit usually means the session ended or vanished while we
	// were attaching — the dashboard loop's refresh handles that quietly.
}

async function dashboardLoop(
	ctx: ExtensionContext,
	manager: AppManager,
	selection: DashboardSelection,
): Promise<void> {
	while (true) {
		manager.refresh();
		if (manager.size() === 0) {
			ctx.ui.notify(
				"No interactive apps in this project. Start one with /app <command>.",
				"info",
			);
			return;
		}

		const action = await ctx.ui.custom<AppAction | null>(
			(tui, theme, keybindings, done) =>
				new AppDashboard(tui, theme, keybindings, manager, selection, done),
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
			},
		);

		if (!action) {
			// Escape, or the dashboard auto-closed because every app exited.
			if (manager.size() === 0) {
				ctx.ui.notify(
					"All interactive apps in this project have exited.",
					"info",
				);
			}
			return;
		}

		if (action.type === "attach") {
			if (manager.get(action.id)) await attachTo(ctx, manager, action.id);
			continue;
		}

		// action.type === "kill" — confirm outside the overlay; an attached
		// editor may hold unsaved work.
		const snap = manager.get(action.id);
		if (!snap) continue;
		const confirmed = await ctx.ui.confirm(
			"Stop app",
			`Stop "${snap.label}" (${snap.id})? Unsaved work in it will be lost.`,
		);
		if (confirmed) {
			try {
				manager.kill(action.id);
			} catch (error) {
				notifyError(ctx, error);
			}
		}
	}
}

async function runApp(ctx: ExtensionContext, args: string): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Interactive apps require Pi's interactive TUI.", "error");
		return;
	}
	const command = (args ?? "").trim();
	if (command.includes("\u0000")) {
		ctx.ui.notify("Command contains a NUL byte.", "error");
		return;
	}

	const manager = new AppManager(ctx.cwd);
	const selection: DashboardSelection = { index: 0 };
	try {
		if (command) {
			const session = manager.start(command);
			selection.id = session.id;
			await attachTo(ctx, manager, session.id);
		}
		await dashboardLoop(ctx, manager, selection);
	} catch (error) {
		notifyError(ctx, error);
	}
}

export default function (pi: ExtensionAPI) {
	let statusManager: AppManager | undefined;
	let statusTimer: ReturnType<typeof setInterval> | undefined;

	const stopStatus = (ctx: ExtensionContext) => {
		if (statusTimer) clearInterval(statusTimer);
		statusTimer = undefined;
		statusManager = undefined;
		ctx.ui.setStatus(STATUS_ID, undefined);
	};

	const refreshStatus = (ctx: ExtensionContext) => {
		try {
			statusManager?.refresh();
			const text = formatAppStatus(statusManager?.list() ?? []);
			ctx.ui.setStatus(
				STATUS_ID,
				text ? ctx.ui.theme.fg("accent", text) : undefined,
			);
		} catch {
			// Commands report tmux errors. A footer poll should stay quiet.
			ctx.ui.setStatus(STATUS_ID, undefined);
		}
	};

	pi.on("session_start", (_event, ctx) => {
		if (statusTimer) clearInterval(statusTimer);
		if (ctx.mode !== "tui") return;
		statusManager = new AppManager(ctx.cwd);
		refreshStatus(ctx);
		statusTimer = setInterval(() => refreshStatus(ctx), STATUS_POLL_MS);
		statusTimer.unref?.();
	});

	pi.on("session_shutdown", (_event, ctx) => stopStatus(ctx));

	pi.registerCommand("app", {
		description:
			"Start or manage persistent interactive apps (/app <command>, /app for the dashboard)",
		handler: (args, ctx) => runApp(ctx, args ?? ""),
	});

	pi.registerCommand("tode", {
		description: "Open the current project in Tode (alias for /app tode .)",
		handler: (_args, ctx) => runApp(ctx, "tode ."),
	});
}
