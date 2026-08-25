import assert from "node:assert/strict";
import test from "node:test";
import type { AppSession } from "./src/manager.ts";
import {
	AppDashboard,
	reconcileDashboardSelection,
	type AppAction,
	type AppManagerView,
	type DashboardSelection,
} from "./src/ui/apps.ts";
import {
	formatAge,
	oneLine,
	padToWidth,
	truncateToWidth,
	visibleWidth,
} from "./src/ui/text.ts";

// --- Text helpers ------------------------------------------------------------

test("oneLine flattens control characters, ANSI, and whitespace", () => {
	assert.equal(oneLine("a\nb\tc"), "a b c");
	assert.equal(oneLine("\u001b[31mred\u001b[0m"), "red");
	assert.equal(oneLine("  spaced   out  "), "spaced out");
});

test("visibleWidth and truncateToWidth are ANSI-aware", () => {
	const styled = "\u001b[31mhello\u001b[0m world";
	assert.equal(visibleWidth(styled), 11);
	assert.equal(truncateToWidth("plain text", 5), "plain");
	assert.equal(truncateToWidth(styled, 20), styled);
	const cut = truncateToWidth(styled, 7);
	assert.equal(visibleWidth(cut), 7);
	assert.ok(cut.endsWith("\u001b[0m"));
	assert.equal(truncateToWidth("anything", 0), "");
	assert.equal(padToWidth("ab", 5), "ab   ");
	assert.equal(visibleWidth(padToWidth(styled, 15)), 15);
});

test("formatAge renders compact ages", () => {
	const now = 1_000_000_000;
	assert.equal(formatAge(now - 5_000, now), "5s");
	assert.equal(formatAge(now - 300_000, now), "5m");
	assert.equal(formatAge(now - 7_200_000, now), "2h");
	assert.equal(formatAge(now - 3 * 86_400_000, now), "3d");
	assert.equal(formatAge(now + 60_000, now), "0s");
});

// --- Selection ---------------------------------------------------------------

test("dashboard selection follows its session id and falls back by row", () => {
	const selection: DashboardSelection = { id: "pi-app-7", index: 6 };

	reconcileDashboardSelection(selection, [
		{ id: "pi-app-new" },
		...Array.from({ length: 8 }, (_, index) => ({ id: `pi-app-${index + 1}` })),
	]);
	assert.deepEqual(selection, { id: "pi-app-7", index: 7 });

	reconcileDashboardSelection(selection, [{ id: "pi-app-1" }, { id: "pi-app-2" }]);
	assert.deepEqual(selection, { id: "pi-app-2", index: 1 });

	reconcileDashboardSelection(selection, []);
	assert.deepEqual(selection, { id: undefined, index: 0 });
});

// --- Dashboard component -----------------------------------------------------

function session(id: string, extra: Partial<AppSession> = {}): AppSession {
	return {
		id,
		label: "btop",
		cwd: "/project",
		createdAt: Date.now() - 60_000,
		attached: 0,
		...extra,
	};
}

function fakeView(initial: AppSession[]) {
	let sessions = initial;
	const listeners = new Set<() => void>();
	let refreshes = 0;
	const view: AppManagerView = {
		list: () => sessions,
		get: (id) => sessions.find((s) => s.id === id),
		size: () => sessions.length,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		refresh: () => {
			refreshes++;
		},
	};
	return {
		view,
		refreshes: () => refreshes,
		set: (next: AppSession[]) => {
			sessions = next;
			for (const listener of listeners) listener();
		},
	};
}

function fakeTui() {
	let renders = 0;
	return {
		tui: {
			requestRender: () => renders++,
			terminal: { rows: 20 },
		} as never,
		renders: () => renders,
	};
}

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as never;

const keybindings = {
	matches: (data: string, binding: string) => data === binding,
	getKeys: () => ["key"],
} as never;

function makeDashboard(
	sessions: AppSession[],
	selection: DashboardSelection = { index: 0 },
	allProjects = false,
) {
	const server = fakeView(sessions);
	const results: Array<AppAction | null> = [];
	const { tui, renders } = fakeTui();
	const dashboard = new AppDashboard(
		tui,
		theme,
		keybindings,
		server.view,
		selection,
		(value) => results.push(value),
		allProjects,
	);
	return { dashboard, server, results, selection, renders };
}

test("enter resolves an attach action for the selected session", () => {
	const { dashboard, results } = makeDashboard([
		session("pi-app-aaaaaaaa"),
		session("pi-app-bbbbbbbb"),
	]);
	dashboard.handleInput("tui.select.down");
	dashboard.handleInput("tui.select.confirm");
	assert.deepEqual(results, [{ type: "attach", id: "pi-app-bbbbbbbb" }]);
	dashboard.dispose();
});

test("x resolves a kill action and escape resolves null exactly once", () => {
	const first = makeDashboard([session("pi-app-aaaaaaaa")]);
	first.dashboard.handleInput("x");
	assert.deepEqual(first.results, [{ type: "kill", id: "pi-app-aaaaaaaa" }]);
	// Closed: further input resolves nothing else.
	first.dashboard.handleInput("tui.select.confirm");
	assert.equal(first.results.length, 1);

	const second = makeDashboard([session("pi-app-aaaaaaaa")]);
	second.dashboard.handleInput("tui.select.cancel");
	assert.deepEqual(second.results, [null]);
	second.dashboard.dispose();
	assert.equal(second.results.length, 1);
});

test("j/k navigation wraps and keeps the selected id stable", () => {
	const sessions = [
		session("pi-app-aaaaaaaa"),
		session("pi-app-bbbbbbbb"),
		session("pi-app-cccccccc"),
	];
	const { dashboard, selection, server } = makeDashboard(sessions);
	dashboard.handleInput("j");
	dashboard.handleInput("j");
	assert.equal(selection.id, "pi-app-cccccccc");
	dashboard.handleInput("j"); // wraps
	assert.equal(selection.id, "pi-app-aaaaaaaa");
	dashboard.handleInput("k"); // wraps back
	assert.equal(selection.id, "pi-app-cccccccc");

	// Selected session removed → selection falls back by row.
	server.set([sessions[0], sessions[1]]);
	dashboard.handleInput("tui.select.confirm");
	dashboard.dispose();
});

test("global rendering groups projects while navigation targets only sessions", () => {
	const sessions = [
		session("pi-app-aaaaaaaa", { label: "same", cwd: "/a/project" }),
		session("pi-app-bbbbbbbb", { label: "same", cwd: "/z/project\nname" }),
	];
	const { dashboard, results } = makeDashboard(sessions, { index: 0 }, true);
	const rendered = dashboard.render(120).join("\n");
	assert.match(rendered, /2 apps across 2 projects/);
	assert.match(rendered, /\/a\/project/);
	assert.match(rendered, /\/z\/project name/);

	dashboard.handleInput("tui.select.down");
	dashboard.handleInput("tui.select.confirm");
	assert.deepEqual(results, [{ type: "attach", id: "pi-app-bbbbbbbb" }]);
	dashboard.dispose();

	const stop = makeDashboard(sessions, { index: 0 }, true);
	stop.dashboard.handleInput("j");
	stop.dashboard.handleInput("x");
	assert.deepEqual(stop.results, [{ type: "kill", id: "pi-app-bbbbbbbb" }]);
	stop.dashboard.dispose();
});

test("the refresh timer polls, auto-closes when empty, and stops on dispose", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { dashboard, server, results, renders } = makeDashboard([
		session("pi-app-aaaaaaaa"),
	]);

	t.mock.timers.tick(2000);
	assert.equal(server.refreshes(), 2);
	assert.deepEqual(results, []);

	// A change notification triggers a redraw.
	const before = renders();
	server.set([session("pi-app-aaaaaaaa", { attached: 1 })]);
	assert.equal(renders(), before + 1);

	// All apps exit → next poll auto-closes with null.
	server.set([]);
	t.mock.timers.tick(1000);
	assert.deepEqual(results, [null]);

	const after = server.refreshes();
	dashboard.dispose(); // idempotent, timer stopped
	dashboard.dispose();
	t.mock.timers.tick(5000);
	assert.equal(server.refreshes(), after);
	assert.equal(results.length, 1);
});

test("rendering stays inside narrow widths and fixed height", () => {
	const many = Array.from({ length: 30 }, (_, i) =>
		session(`pi-app-${String(i).padStart(8, "0")}`, {
			label: "a-rather-long-application-label",
			attached: i % 2,
		}),
	);
	const { dashboard } = makeDashboard(many, { index: 20 });
	for (const width of [24, 40, 120]) {
		const lines = dashboard.render(width);
		// rows 20 → bodyHeight 15 + header + 2 borders + hints = 19 lines.
		assert.equal(lines.length, 19);
		for (const line of lines) {
			assert.ok(
				visibleWidth(line) <= width,
				`line wider than ${width}: ${JSON.stringify(line)}`,
			);
		}
	}
	// Scroll indicators appear when the list overflows the viewport.
	const flat = dashboard.render(80).join("\n");
	assert.match(flat, /more/);
	dashboard.dispose();
});

test("global grouped overflow keeps a later selected app visible", () => {
	const many = Array.from({ length: 30 }, (_, i) =>
		session(`pi-app-${String(i).padStart(8, "0")}`, {
			cwd: i < 15 ? "/a/project" : "/z/a-very-long-project-directory",
			label: "a-rather-long-application-label",
		}),
	);
	const { dashboard } = makeDashboard(many, { index: 20 }, true);
	for (const width of [24, 40, 120]) {
		const lines = dashboard.render(width);
		assert.ok(lines.some((line) => line.includes("❯")));
		assert.match(lines.join("\n"), /more/);
		for (const line of lines) assert.ok(visibleWidth(line) <= width);
	}
	dashboard.dispose();
});

test("rendering an empty list is safe while the auto-close race resolves", () => {
	const { dashboard } = makeDashboard([]);
	const lines = dashboard.render(60);
	assert.ok(lines.length > 0);
	dashboard.dispose();
});
