/**
 * /app dashboard — a full-screen overlay over the synchronous AppManager
 * read model, adapted from the proven /ps TerminalDashboard. One stage only:
 * Enter resolves an attach action, `x` resolves a kill action (the command
 * orchestrator confirms and executes), Escape resolves null.
 */

import type {
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { AppSession } from "../manager.ts";
import {
	formatAge,
	oneLine,
	padToWidth,
	truncateToWidth,
	visibleWidth,
} from "./text.ts";

/** The slice of AppManager the dashboard needs; faked in tests. */
export interface AppManagerView {
	list(): ReadonlyArray<AppSession>;
	get(id: string): AppSession | undefined;
	size(): number;
	subscribe(listener: () => void): () => void;
	refresh(): void;
}

export type AppAction =
	| { type: "attach"; id: string }
	| { type: "kill"; id: string };

export interface DashboardSelection {
	id?: string;
	index: number;
}

export function reconcileDashboardSelection(
	selection: DashboardSelection,
	sessions: ReadonlyArray<Pick<AppSession, "id">>,
) {
	const stableIndex = selection.id
		? sessions.findIndex((snap) => snap.id === selection.id)
		: -1;
	selection.index =
		stableIndex >= 0
			? stableIndex
			: Math.min(
					Math.max(0, selection.index),
					Math.max(0, sessions.length - 1),
				);
	selection.id = sessions[selection.index]?.id;
}

function configuredKeys(
	keybindings: KeybindingsManager,
	binding: Parameters<KeybindingsManager["getKeys"]>[0],
) {
	return keybindings.getKeys(binding).join("/") || "unbound";
}

export class AppDashboard implements Component {
	private tui: TUI;
	private theme: Theme;
	private keybindings: KeybindingsManager;
	private view: AppManagerView;
	private selection: DashboardSelection;
	private done: (value: AppAction | null) => void;
	private allProjects: boolean;

	private closed = false;
	private ticker: ReturnType<typeof setInterval>;
	private unsubChange: () => void;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		view: AppManagerView,
		selection: DashboardSelection,
		done: (value: AppAction | null) => void,
		allProjects = false,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.view = view;
		this.selection = selection;
		this.done = done;
		this.allProjects = allProjects;
		// Live refresh at 1Hz; the subscription only fires on real change,
		// so identical polls do not trigger redraws.
		this.ticker = setInterval(() => {
			try {
				this.view.refresh();
			} catch {
				// Keep showing the last snapshot; the orchestrator surfaces
				// persistent tmux failures on its own calls.
			}
			if (this.view.size() === 0) this.close(null);
		}, 1000);
		this.unsubChange = view.subscribe(() => this.tui.requestRender());
	}

	private cleanup() {
		if (this.closed) return false;
		this.closed = true;
		clearInterval(this.ticker);
		this.unsubChange();
		return true;
	}

	private close(result: AppAction | null) {
		if (this.cleanup()) this.done(result);
	}

	dispose(): void {
		this.cleanup();
	}

	handleInput(data: string): void {
		const sessions = this.view.list();
		reconcileDashboardSelection(this.selection, sessions);

		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.close(null);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			const snap = sessions[this.selection.index];
			if (snap) this.close({ type: "attach", id: snap.id });
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
			if (sessions.length > 0) {
				this.selection.index =
					(this.selection.index - 1 + sessions.length) % sessions.length;
				this.selection.id = sessions[this.selection.index]?.id;
				this.tui.requestRender();
			}
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
			if (sessions.length > 0) {
				this.selection.index = (this.selection.index + 1) % sessions.length;
				this.selection.id = sessions[this.selection.index]?.id;
				this.tui.requestRender();
			}
			return;
		}
		if (data === "x") {
			const snap = sessions[this.selection.index];
			if (snap) this.close({ type: "kill", id: snap.id });
			return;
		}
	}

	private borderSegment(width: number, title: string): string {
		const theme = this.theme;
		const label = title
			? ` ${truncateToWidth(title, Math.max(0, width - 3))} `
			: "";
		const labelWidth = visibleWidth(label);
		return (
			theme.fg("border", "─") +
			(label ? theme.fg("text", label) : "") +
			theme.fg("border", "─".repeat(Math.max(0, width - 1 - labelWidth)))
		);
	}

	render(width: number): string[] {
		const theme = this.theme;
		const sessions = this.view.list();
		reconcileDashboardSelection(this.selection, sessions);

		const rows = this.tui.terminal.rows || 30;
		// Same fixed-height model as /ps: cover everything but Pi's footer.
		const bodyHeight = Math.max(6, rows - 5);
		const innerWidth = width - 2;

		const lines: string[] = [];

		const headerLeft = theme.fg("accent", theme.bold("Interactive apps"));
		const projectCount = new Set(sessions.map((session) => session.cwd)).size;
		const headerRight = theme.fg(
			"muted",
			this.allProjects
				? `${sessions.length} app${sessions.length === 1 ? "" : "s"} across ${projectCount} project${projectCount === 1 ? "" : "s"}`
				: `${sessions.length} app${sessions.length === 1 ? "" : "s"} in this project`,
		);
		const headerPad = Math.max(
			1,
			width - visibleWidth(headerLeft) - visibleWidth(headerRight) - 4,
		);
		lines.push(
			truncateToWidth(
				`  ${headerLeft}${" ".repeat(headerPad)}${headerRight}  `,
				width,
			),
		);

		const attachedCount = sessions.filter((s) => s.attached > 0).length;
		lines.push(
			theme.fg("border", "╭") +
				this.borderSegment(
					innerWidth,
					`apps · ${attachedCount} attached / ${sessions.length}`,
				) +
				theme.fg("border", "╮"),
		);

		const divider = theme.fg("border", "│");
		const rowLines = this.renderRows(sessions, innerWidth, bodyHeight);
		for (let i = 0; i < bodyHeight; i++) {
			lines.push(divider + padToWidth(rowLines[i] ?? "", innerWidth) + divider);
		}

		lines.push(
			theme.fg("border", "╰") +
				theme.fg("border", "─".repeat(Math.max(0, innerWidth))) +
				theme.fg("border", "╯"),
		);

		lines.push(
			truncateToWidth(
				theme.fg(
					"dim",
					`  ${configuredKeys(this.keybindings, "tui.select.up")}/${configuredKeys(this.keybindings, "tui.select.down")}/jk select · ${configuredKeys(this.keybindings, "tui.select.confirm")} attach · x stop · ${configuredKeys(this.keybindings, "tui.select.cancel")} close · inside app: Ctrl+B then D detaches`,
				),
				width,
			),
		);

		return lines;
	}

	private renderRows(
		sessions: ReadonlyArray<AppSession>,
		width: number,
		height: number,
	): string[] {
		const theme = this.theme;
		const rows: Array<
			| { cwd: string }
			| { session: AppSession; sessionIndex: number }
		> = [];
		let previousCwd: string | undefined;
		for (let sessionIndex = 0; sessionIndex < sessions.length; sessionIndex++) {
			const session = sessions[sessionIndex];
			if (this.allProjects && session.cwd !== previousCwd) {
				rows.push({ cwd: session.cwd });
				previousCwd = session.cwd;
			}
			rows.push({ session, sessionIndex });
		}

		const selectedRow = Math.max(
			0,
			rows.findIndex(
				(row) =>
					"sessionIndex" in row && row.sessionIndex === this.selection.index,
			),
		);
		const start =
			rows.length > height
				? Math.min(
						Math.max(0, selectedRow - Math.floor(height / 2)),
						rows.length - height,
					)
				: 0;
		const visible = rows.slice(start, start + height);
		const out = visible.map((row) => {
			if ("cwd" in row) {
				return truncateToWidth(
					theme.fg("dim", `  ${oneLine(row.cwd)}`),
					width,
				);
			}

			const { session: snap, sessionIndex } = row;
			const isSelected = sessionIndex === this.selection.index;
			const marker = isSelected ? theme.fg("accent", "❯") : " ";
			const glyph =
				snap.attached > 0
					? theme.fg("success", "■")
					: theme.fg("muted", "■");
			const label = isSelected
				? theme.fg("accent", oneLine(snap.label))
				: theme.fg("text", oneLine(snap.label));
			const left = ` ${marker} ${glyph} ${label} ${theme.fg("dim", snap.id)}`;
			const dot = theme.fg("dim", " · ");
			const right = `${[
				theme.fg("muted", formatAge(snap.createdAt)),
				snap.attached > 0
					? theme.fg("success", "attached")
					: theme.fg("muted", "detached"),
			].join(dot)} `;
			const rightWidth = visibleWidth(right);
			const leftTruncated = truncateToWidth(
				left,
				Math.max(0, width - rightWidth - 2),
			);
			const gap = Math.max(2, width - visibleWidth(leftTruncated) - rightWidth);
			return truncateToWidth(leftTruncated + " ".repeat(gap) + right, width);
		});

		if (start > 0) {
			out[0] = truncateToWidth(theme.fg("dim", `   ... ${start} more`), width);
		}
		if (start + height < rows.length) {
			out[out.length - 1] = truncateToWidth(
				theme.fg("dim", `   ... ${rows.length - start - height} more`),
				width,
			);
		}
		return out;
	}

	invalidate(): void {}
}
