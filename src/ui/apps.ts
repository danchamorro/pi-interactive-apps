/**
 * /app dashboard, a full-screen overlay over the synchronous AppManager
 * read model. Running sessions and profile-wide favorites share one list.
 * The command orchestrator executes start, attach, stop, add, and remove
 * actions after the overlay closes.
 */

import type {
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { AppFavorite } from "../favorites.ts";
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
	| { type: "kill"; id: string }
	| { type: "start"; command: string }
	| { type: "removeFavorite"; command: string }
	| { type: "addFavorite" };

export interface DashboardSelection {
	id?: string;
	index: number;
}

type DashboardItem =
	| { id: string; type: "session"; session: AppSession }
	| { id: string; type: "favorite"; favorite: AppFavorite };

function dashboardItems(
	sessions: ReadonlyArray<AppSession>,
	favorites: ReadonlyArray<AppFavorite>,
	allProjects: boolean,
): DashboardItem[] {
	return [
		...sessions.map((session) => ({
			id: session.id,
			type: "session" as const,
			session,
		})),
		...(allProjects
			? []
			: favorites.map((favorite) => ({
					id: `favorite:${favorite.command}`,
					type: "favorite" as const,
					favorite,
				}))),
	];
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
	private favorites: ReadonlyArray<AppFavorite>;

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
		favorites: ReadonlyArray<AppFavorite> = [],
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.view = view;
		this.selection = selection;
		this.done = done;
		this.allProjects = allProjects;
		this.favorites = favorites;
		// Live refresh at 1Hz; the subscription only fires on real change,
		// so identical polls do not trigger redraws.
		this.ticker = setInterval(() => {
			try {
				this.view.refresh();
			} catch {
				// Keep showing the last snapshot; the orchestrator surfaces
				// persistent tmux failures on its own calls.
			}
			if (this.allProjects && this.view.size() === 0) this.close(null);
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
		const items = dashboardItems(
			this.view.list(),
			this.favorites,
			this.allProjects,
		);
		reconcileDashboardSelection(this.selection, items);
		const selected = items[this.selection.index];

		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.close(null);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			if (selected?.type === "session") {
				this.close({ type: "attach", id: selected.session.id });
			} else if (selected?.type === "favorite") {
				this.close({ type: "start", command: selected.favorite.command });
			}
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
			if (items.length > 0) {
				this.selection.index =
					(this.selection.index - 1 + items.length) % items.length;
				this.selection.id = items[this.selection.index]?.id;
				this.tui.requestRender();
			}
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
			if (items.length > 0) {
				this.selection.index = (this.selection.index + 1) % items.length;
				this.selection.id = items[this.selection.index]?.id;
				this.tui.requestRender();
			}
			return;
		}
		if (data === "x") {
			if (selected?.type === "session") {
				this.close({ type: "kill", id: selected.session.id });
			} else if (selected?.type === "favorite") {
				this.close({
					type: "removeFavorite",
					command: selected.favorite.command,
				});
			}
			return;
		}
		if (data === "a" && !this.allProjects) this.close({ type: "addFavorite" });
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
		const items = dashboardItems(sessions, this.favorites, this.allProjects);
		reconcileDashboardSelection(this.selection, items);

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
				: `${sessions.length} app${sessions.length === 1 ? "" : "s"} · ${this.favorites.length} favorite${this.favorites.length === 1 ? "" : "s"}`,
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
		const rowLines = this.renderRows(
			sessions,
			this.favorites,
			innerWidth,
			bodyHeight,
		);
		for (let i = 0; i < bodyHeight; i++) {
			lines.push(divider + padToWidth(rowLines[i] ?? "", innerWidth) + divider);
		}

		lines.push(
			theme.fg("border", "╰") +
				theme.fg("border", "─".repeat(Math.max(0, innerWidth))) +
				theme.fg("border", "╯"),
		);

		const help = this.allProjects
			? `${configuredKeys(this.keybindings, "tui.select.up")}/${configuredKeys(this.keybindings, "tui.select.down")}/jk select · ${configuredKeys(this.keybindings, "tui.select.confirm")} attach · x stop · ${configuredKeys(this.keybindings, "tui.select.cancel")} close`
			: `${configuredKeys(this.keybindings, "tui.select.up")}/${configuredKeys(this.keybindings, "tui.select.down")}/jk select · ${configuredKeys(this.keybindings, "tui.select.confirm")} open · x stop/remove · a add favorite · ${configuredKeys(this.keybindings, "tui.select.cancel")} close`;
		lines.push(
			truncateToWidth(theme.fg("dim", `  ${help} · inside app: Ctrl+B then D detaches`), width),
		);

		return lines;
	}

	private renderRows(
		sessions: ReadonlyArray<AppSession>,
		favorites: ReadonlyArray<AppFavorite>,
		width: number,
		height: number,
	): string[] {
		const theme = this.theme;
		const items = dashboardItems(sessions, favorites, this.allProjects);
		const rows: Array<{ heading: string } | { item: DashboardItem; itemIndex: number }> = [];
		let previousCwd: string | undefined;
		for (let itemIndex = 0; itemIndex < sessions.length; itemIndex++) {
			const item = items[itemIndex];
			if (item?.type !== "session") continue;
			if (this.allProjects && item.session.cwd !== previousCwd) {
				rows.push({ heading: item.session.cwd });
				previousCwd = item.session.cwd;
			}
			rows.push({ item, itemIndex });
		}
		if (!this.allProjects && favorites.length > 0) {
			rows.push({ heading: `favorites · ${favorites.length}` });
			for (let itemIndex = sessions.length; itemIndex < items.length; itemIndex++) {
				rows.push({ item: items[itemIndex], itemIndex });
			}
		}
		if (rows.length === 0) {
			const message = this.allProjects
				? "  No apps are running."
				: "  No apps or favorites yet. Press a to add a favorite.";
			return [theme.fg("muted", message)];
		}

		const selectedRow = Math.max(
			0,
			rows.findIndex(
				(row) => "itemIndex" in row && row.itemIndex === this.selection.index,
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
			if ("heading" in row) {
				return truncateToWidth(theme.fg("dim", `  ${oneLine(row.heading)}`), width);
			}

			const isSelected = row.itemIndex === this.selection.index;
			const marker = isSelected ? theme.fg("accent", "❯") : " ";
			if (row.item.type === "favorite") {
				const favorite = row.item.favorite;
				const label = isSelected
					? theme.fg("accent", oneLine(favorite.label))
					: theme.fg("text", oneLine(favorite.label));
				const left = ` ${marker} ${theme.fg("warning", "★")} ${label}`;
				const right = `${theme.fg("muted", oneLine(favorite.command))} `;
				const rightWidth = Math.min(visibleWidth(right), Math.floor(width / 2));
				const leftTruncated = truncateToWidth(left, Math.max(0, width - rightWidth - 2));
				const rightTruncated = truncateToWidth(right, rightWidth);
				const gap = Math.max(2, width - visibleWidth(leftTruncated) - visibleWidth(rightTruncated));
				return truncateToWidth(leftTruncated + " ".repeat(gap) + rightTruncated, width);
			}

			const snap = row.item.session;
			const glyph = snap.attached > 0
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
			const leftTruncated = truncateToWidth(left, Math.max(0, width - rightWidth - 2));
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
