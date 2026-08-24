import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import appsExtension, { formatAppStatus } from "./index.ts";

// --- Stub tmux on PATH -------------------------------------------------------
// A tiny node script that maintains a JSON session store, so the manager,
// attach handoff, and dashboard loop run end to end without a real tmux.

const STUB_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");
const statePath = process.env.TMUX_STUB_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TMUX_STUB_LOG, JSON.stringify(args) + "\\n");
const read = () => { try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return {}; } };
const write = (s) => fs.writeFileSync(statePath, JSON.stringify(s));
const target = () => { const i = args.indexOf("-t"); return (args[i + 1] || "").replace(/^=/, ""); };
const fail = (msg) => { process.stderr.write(msg + "\\n"); process.exit(1); };
const sessions = read();
switch (args[2]) {
	case "new-session": {
		const name = args[args.indexOf("-s") + 1];
		sessions[name] = { created: 1700000000 + Object.keys(sessions).length, attached: 0, opts: {} };
		write(sessions);
		break;
	}
	case "set-option": {
		if (args[3] === "-s") break;
		const session = sessions[target()];
		if (!session) fail("no such session: " + target());
		session.opts[args[5]] = args[6];
		write(sessions);
		break;
	}
	case "set-environment": {
		if (!sessions[target()]) fail("no such session: " + target());
		break;
	}
	case "list-sessions": {
		const names = Object.keys(sessions);
		if (names.length === 0) fail("no server running on /tmp/stub");
		for (const name of names) {
			const s = sessions[name];
			process.stdout.write([name, s.created, s.attached, s.opts["@pi_app_cwd"] || "", s.opts["@pi_app_label"] || ""].join("\\t") + "\\n");
		}
		break;
	}
	case "kill-session": {
		if (!sessions[target()]) fail("can't find session: " + target());
		delete sessions[target()];
		write(sessions);
		break;
	}
	case "attach-session": {
		if (!sessions[target()]) fail("can't find session: " + target());
		break;
	}
}
process.exit(0);
`;

interface Registered {
	commands: Map<string, (args: string, ctx: unknown) => Promise<void> | void>;
	events: Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>;
}

function register(): Registered {
	const commands = new Map();
	const events = new Map();
	appsExtension({
		on: (name: string, handler: never) => events.set(name, handler),
		registerCommand: (name: string, options: { handler: never }) =>
			commands.set(name, options.handler),
	} as unknown as ExtensionAPI);
	return { commands, events };
}

type DashboardScript = (component: {
	handleInput(data: string): void;
}) => void;

function makeCtx(options: {
	cwd: string;
	mode?: string;
	scripts?: DashboardScript[];
	confirms?: boolean[];
}) {
	const notifications: string[] = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const tuiEvents: string[] = [];
	const scripts = options.scripts ?? [];
	const confirms = options.confirms ?? [];
	const theme = {
		fg: (_c: string, text: string) => text,
		bold: (text: string) => text,
	};
	const keybindings = {
		matches: (data: string, binding: string) => data === binding,
		getKeys: () => ["key"],
	};
	const tui = {
		stop: () => tuiEvents.push("stop"),
		start: () => tuiEvents.push("start"),
		requestRender: (force?: boolean) => {
			if (force) tuiEvents.push("render:force");
		},
		terminal: { rows: 20 },
	};
	const ctx = {
		mode: options.mode ?? "tui",
		cwd: options.cwd,
		ui: {
			theme,
			setStatus: (key: string, text: string | undefined) =>
				statuses.push({ key, text }),
			notify: (message: string, type?: string) =>
				notifications.push(`${type ?? "info"}:${message}`),
			confirm: async () => confirms.shift() ?? false,
			custom: (factory: never, customOptions?: { overlay?: boolean }) =>
				new Promise((resolve) => {
					let component: { dispose?: () => void } | undefined;
					let settled = false;
					const done = (value: unknown) => {
						if (settled) return;
						settled = true;
						queueMicrotask(() => component?.dispose?.());
						resolve(value);
					};
					component = (factory as (...args: unknown[]) => never)(
						tui,
						theme,
						keybindings,
						done,
					);
					if (!settled && customOptions?.overlay) {
						const script =
							scripts.shift() ??
							((c: { handleInput(data: string): void }) =>
								c.handleInput("tui.select.cancel"));
						queueMicrotask(() =>
							script(component as { handleInput(data: string): void }),
						);
					}
				}),
		},
	};
	return { ctx, notifications, statuses, tuiEvents };
}

function withStub(t: { after(fn: () => void): void }) {
	const dir = mkdtempSync(join(tmpdir(), "pi-apps-test-"));
	const binDir = join(dir, "bin");
	const projectDir = join(dir, "project");
	mkdirSync(binDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(join(binDir, "tmux"), STUB_SOURCE);
	chmodSync(join(binDir, "tmux"), 0o755);
	const statePath = join(dir, "state.json");
	const logPath = join(dir, "log.txt");
	writeFileSync(logPath, "");

	const oldPath = process.env.PATH;
	const oldState = process.env.TMUX_STUB_STATE;
	const oldLog = process.env.TMUX_STUB_LOG;
	process.env.PATH = `${binDir}:${oldPath}`;
	process.env.TMUX_STUB_STATE = statePath;
	process.env.TMUX_STUB_LOG = logPath;
	t.after(() => {
		process.env.PATH = oldPath;
		if (oldState === undefined) delete process.env.TMUX_STUB_STATE;
		else process.env.TMUX_STUB_STATE = oldState;
		if (oldLog === undefined) delete process.env.TMUX_STUB_LOG;
		else process.env.TMUX_STUB_LOG = oldLog;
		rmSync(dir, { recursive: true, force: true });
	});

	return {
		projectDir: realpathSync(projectDir),
		state: () => {
			try {
				return JSON.parse(readFileSync(statePath, "utf8"));
			} catch {
				return {};
			}
		},
		seed: (sessions: Record<string, unknown>) =>
			writeFileSync(statePath, JSON.stringify(sessions)),
		log: () =>
			readFileSync(logPath, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as string[]),
	};
}

function seedSession(
	stub: ReturnType<typeof withStub>,
	id: string,
	label: string,
	attached = 0,
) {
	stub.seed({
		[id]: {
			created: 1700000100,
			attached,
			opts: {
				"@pi_app_cwd": Buffer.from(stub.projectDir, "utf8").toString("base64url"),
				"@pi_app_label": Buffer.from(label, "utf8").toString("base64url"),
			},
		},
	});
}

// --- Tests -------------------------------------------------------------------

test("registers /app and /tode", () => {
	const { commands, events } = register();
	assert.deepEqual([...commands.keys()].sort(), ["app", "tode"]);
	assert.deepEqual([...events.keys()].sort(), ["session_shutdown", "session_start"]);
});

test("formatAppStatus hides zero apps and reports attached clients", () => {
	assert.equal(formatAppStatus([]), undefined);
	assert.equal(formatAppStatus([{ attached: 0 }, { attached: 0 }]), "apps 2");
	assert.equal(
		formatAppStatus([{ attached: 1 }, { attached: 0 }, { attached: 2 }]),
		"apps 3 · 2 attached",
	);
});

test("the footer tracks current-project apps and clears on shutdown", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const stub = withStub(t);
	seedSession(stub, "pi-app-00000001", "lazygit", 1);
	const { events } = register();
	const { ctx, statuses } = makeCtx({ cwd: stub.projectDir });

	await events.get("session_start")!({ reason: "startup" }, ctx);
	assert.deepEqual(statuses.at(-1), {
		key: "interactive-apps",
		text: "apps 1 · 1 attached",
	});

	stub.seed({});
	t.mock.timers.tick(2_000);
	assert.deepEqual(statuses.at(-1), {
		key: "interactive-apps",
		text: undefined,
	});

	await events.get("session_shutdown")!({ reason: "quit" }, ctx);
	const count = statuses.length;
	t.mock.timers.tick(4_000);
	assert.equal(statuses.length, count);
});

test("non-TUI modes are rejected without touching tmux", async (t) => {
	const stub = withStub(t);
	const { commands } = register();
	const { ctx, notifications } = makeCtx({ cwd: stub.projectDir, mode: "rpc" });
	await commands.get("app")!("btop", ctx);
	assert.match(notifications[0], /error:.*TUI/);
	assert.equal(stub.log().length, 0);
});

test("/app <command> starts, attaches, and re-enters the dashboard", async (t) => {
	const stub = withStub(t);
	const { commands } = register();
	const { ctx, notifications, tuiEvents } = makeCtx({
		cwd: stub.projectDir,
		scripts: [(c) => c.handleInput("tui.select.cancel")],
	});

	await commands.get("app")!("btop --utf-force", ctx);

	const log = stub.log();
	const create = log.find((argv) => argv[2] === "new-session");
	assert.ok(create, "new-session was called");
	assert.deepEqual(create.slice(0, 2), ["-L", "pi-apps"]);
	assert.equal(create[create.indexOf("-c") + 1], stub.projectDir);
	assert.ok(create.includes("PI_APP_COMMAND=btop --utf-force"));

	const attach = log.find((argv) => argv[2] === "attach-session");
	assert.ok(attach, "attach-session was called");
	assert.match(attach[attach.indexOf("-t") + 1], /^=pi-app-[0-9a-f]{8}$/);

	// The TUI handoff always restores Pi with a forced redraw.
	assert.deepEqual(tuiEvents, ["stop", "start", "render:force"]);

	// The session survives the command returning (dashboard was escaped).
	assert.equal(Object.keys(stub.state()).length, 1);
	assert.deepEqual(
		notifications.filter((n) => n.startsWith("error:")),
		[],
	);
});

test("/tode is an alias for /app tode .", async (t) => {
	const stub = withStub(t);
	const { commands } = register();
	const { ctx } = makeCtx({
		cwd: stub.projectDir,
		scripts: [(c) => c.handleInput("tui.select.cancel")],
	});
	await commands.get("tode")!("", ctx);
	const create = stub.log().find((argv) => argv[2] === "new-session");
	assert.ok(create);
	assert.ok(create.includes("PI_APP_COMMAND=tode ."));
});

test("enter on a dashboard row attaches to that session", async (t) => {
	const stub = withStub(t);
	seedSession(stub, "pi-app-00000001", "lazygit");
	const { commands } = register();
	const { ctx, tuiEvents } = makeCtx({
		cwd: stub.projectDir,
		scripts: [
			(c) => c.handleInput("tui.select.confirm"),
			(c) => c.handleInput("tui.select.cancel"),
		],
	});
	await commands.get("app")!("", ctx);
	const attach = stub.log().find((argv) => argv[2] === "attach-session");
	assert.ok(attach);
	assert.equal(attach[attach.indexOf("-t") + 1], "=pi-app-00000001");
	assert.deepEqual(tuiEvents, ["stop", "start", "render:force"]);
});

test("x kills only after confirmation", async (t) => {
	const stub = withStub(t);
	seedSession(stub, "pi-app-00000001", "tode");
	const { commands } = register();

	// Cancelled: session survives, dashboard reopens, escape closes.
	const first = makeCtx({
		cwd: stub.projectDir,
		scripts: [
			(c) => c.handleInput("x"),
			(c) => c.handleInput("tui.select.cancel"),
		],
		confirms: [false],
	});
	await commands.get("app")!("", first.ctx);
	assert.equal(Object.keys(stub.state()).length, 1);
	assert.ok(!stub.log().some((argv) => argv[2] === "kill-session"));

	// Confirmed: session is killed and the loop reports the empty project.
	const second = makeCtx({
		cwd: stub.projectDir,
		scripts: [(c) => c.handleInput("x")],
		confirms: [true],
	});
	await commands.get("app")!("", second.ctx);
	assert.deepEqual(stub.state(), {});
	assert.ok(stub.log().some((argv) => argv[2] === "kill-session"));
	assert.match(
		second.notifications.at(-1) ?? "",
		/info:No interactive apps/,
	);
});

test("sessions from another project stay hidden", async (t) => {
	const stub = withStub(t);
	stub.seed({
		"pi-app-00000001": {
			created: 1700000100,
			attached: 0,
			opts: {
				"@pi_app_cwd": Buffer.from("/somewhere/else", "utf8").toString("base64url"),
				"@pi_app_label": Buffer.from("vim", "utf8").toString("base64url"),
			},
		},
	});
	const { commands } = register();
	const { ctx, notifications } = makeCtx({ cwd: stub.projectDir });
	await commands.get("app")!("", ctx);
	assert.match(notifications[0], /info:No interactive apps/);
	// The other project's session was not touched.
	assert.equal(Object.keys(stub.state()).length, 1);
});

test("a missing tmux binary produces a bounded error", async (t) => {
	const stub = withStub(t);
	// Empty PATH → spawnSync fails with ENOENT.
	const oldPath = process.env.PATH;
	process.env.PATH = "/nonexistent-anywhere";
	t.after(() => {
		process.env.PATH = oldPath;
	});
	const { commands } = register();
	const { ctx, notifications } = makeCtx({ cwd: stub.projectDir });
	await commands.get("app")!("btop", ctx);
	assert.match(notifications[0], /error:tmux is unavailable/);
});

test("NUL bytes in a command are rejected up front", async (t) => {
	const stub = withStub(t);
	const { commands } = register();
	const { ctx, notifications } = makeCtx({ cwd: stub.projectDir });
	await commands.get("app")!("ls\u0000-la", ctx);
	assert.match(notifications[0], /error:.*NUL/);
	assert.equal(stub.log().length, 0);
});
