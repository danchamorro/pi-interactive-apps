import assert from "node:assert/strict";
import test from "node:test";
import {
	AppManager,
	AppManagerError,
	LAUNCH_WRAPPER,
	LIST_FORMAT,
	canonicalCwd,
	deriveLabel,
	type TmuxResult,
	type TmuxRunner,
} from "./src/manager.ts";

// --- In-memory fake of the private tmux server -------------------------------

interface FakeSession {
	created: number;
	attached: number;
	opts: Record<string, string>;
	env: Record<string, string>;
}

function encode(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

function fakeServer() {
	const sessions = new Map<string, FakeSession>();
	const calls: string[][] = [];
	let clock = 1700000000;
	const ok: TmuxResult = { status: 0, stdout: "", stderr: "" };
	const err = (stderr: string): TmuxResult => ({ status: 1, stdout: "", stderr });

	const target = (rest: string[]) => {
		const index = rest.indexOf("-t");
		return rest[index + 1]?.replace(/^=/, "") ?? "";
	};

	const run: TmuxRunner = (argv) => {
		calls.push(argv);
		assert.deepEqual(argv.slice(0, 2), ["-L", "pi-apps"]);
		const [, , command, ...rest] = argv;
		switch (command) {
			case "new-session": {
				const name = rest[rest.indexOf("-s") + 1];
				const env: Record<string, string> = {};
				for (let i = 0; i < rest.length; i++) {
					if (rest[i] === "-e") {
						const [key, ...value] = rest[i + 1].split("=");
						env[key] = value.join("=");
					}
				}
				sessions.set(name, { created: clock++, attached: 0, opts: {}, env });
				return { ...ok };
			}
			case "set-option": {
				if (rest[0] === "-s") return { ...ok };
				const session = sessions.get(target(rest));
				if (!session) return err("can't find session");
				session.opts[rest[2]] = rest[3];
				return { ...ok };
			}
			case "set-environment": {
				const session = sessions.get(target(rest));
				if (!session) return err("can't find session");
				delete session.env[rest[3]];
				return { ...ok };
			}
			case "list-sessions": {
				assert.equal(rest[rest.indexOf("-F") + 1], LIST_FORMAT);
				if (sessions.size === 0) {
					return err("no server running on /tmp/tmux-501/pi-apps");
				}
				const lines = [...sessions.entries()].map(
					([name, s]) =>
						`${name}\t${s.created}\t${s.attached}\t${s.opts["@pi_app_cwd"] ?? ""}\t${s.opts["@pi_app_label"] ?? ""}`,
				);
				return { status: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
			}
			case "kill-session": {
				if (!sessions.delete(target(rest))) return err("can't find session");
				return { ...ok };
			}
			default:
				return err(`fake tmux: unhandled ${command}`);
		}
	};

	return { sessions, calls, run };
}

// --- Helpers -----------------------------------------------------------------

test("deriveLabel keeps the leading executable name only", () => {
	assert.equal(deriveLabel("btop"), "btop");
	assert.equal(deriveLabel("  /usr/local/bin/lazygit --flag  "), "lazygit");
	assert.equal(deriveLabel("vim ."), "vim");
	assert.equal(deriveLabel("\u0007\u001b[31m"), "app");
	assert.equal(deriveLabel("x".repeat(64)).length, 32);
});

test("canonicalCwd resolves a nonexistent path without throwing", () => {
	assert.equal(canonicalCwd("/definitely/not/a/real/dir"), "/definitely/not/a/real/dir");
});

// --- Start -------------------------------------------------------------------

test("start creates a tagged session without persisting the full command", () => {
	const server = fakeServer();
	const manager = new AppManager("/tmp", server.run);
	const snap = manager.start("btop --utf-force");

	assert.match(snap.id, /^pi-app-[0-9a-f]{8}$/);
	assert.equal(snap.label, "btop");
	assert.equal(snap.cwd, canonicalCwd("/tmp"));
	assert.equal(snap.attached, 0);

	const create = server.calls.find((c) => c[2] === "new-session");
	assert.ok(create);
	assert.equal(create[create.indexOf("-c") + 1], canonicalCwd("/tmp"));
	assert.equal(create[create.length - 1], LAUNCH_WRAPPER);
	assert.ok(create.includes("PI_APP_COMMAND=btop --utf-force"));
	assert.ok(!LAUNCH_WRAPPER.includes("btop"));

	// Temporary env values are removed from the session environment.
	const unset = server.calls.filter((c) => c[2] === "set-environment");
	assert.deepEqual(
		unset.map((c) => c[c.length - 1]).sort(),
		["PI_APP_COMMAND", "PI_APP_SHELL"],
	);
	assert.deepEqual(server.sessions.get(snap.id)?.env, {});

	// Persistent options never contain the full command.
	const options = server.sessions.get(snap.id)?.opts ?? {};
	for (const value of Object.values(options)) {
		assert.ok(!value.includes("--utf-force"));
		assert.ok(!Buffer.from(value, "base64url").toString("utf8").includes("--utf-force"));
	}
	assert.equal(
		Buffer.from(options["@pi_app_label"], "base64url").toString("utf8"),
		"btop",
	);
});

test("start rejects blank and NUL-byte commands before touching tmux", () => {
	const server = fakeServer();
	const manager = new AppManager("/tmp", server.run);
	assert.throws(() => manager.start("   "), AppManagerError);
	assert.throws(() => manager.start("ls\u0000-la"), AppManagerError);
	assert.equal(server.calls.length, 0);
});

test("start reports a session that exits before metadata is written", () => {
	const server = fakeServer();
	let created = "";
	const run: TmuxRunner = (argv) => {
		const result = server.run(argv);
		if (argv[2] === "new-session") {
			created = argv[argv.indexOf("-s") + 1];
			server.sessions.delete(created); // command exited immediately
		}
		return result;
	};
	const manager = new AppManager("/tmp", run);
	assert.throws(() => manager.start("false"), /exited immediately/);
});

test("start surfaces new-session failures", () => {
	const manager = new AppManager("/tmp", () => ({
		status: 1,
		stdout: "",
		stderr: "create failed",
	}));
	assert.throws(() => manager.start("btop"), /create failed/);
});

test("a missing tmux binary produces a clear error", () => {
	const manager = new AppManager("/tmp", () => ({
		status: null,
		stdout: "",
		stderr: "",
		error: "spawn tmux ENOENT",
	}));
	assert.throws(() => manager.refresh(), /tmux is unavailable/);
});

// --- Listing and filtering ---------------------------------------------------

test("sessions are filtered by canonical project cwd", () => {
	const server = fakeServer();
	const managerA = new AppManager("/tmp", server.run);
	const managerB = new AppManager("/private", server.run);

	const a = managerA.start("btop");
	const b = managerB.start("lazygit");

	managerA.refresh();
	managerB.refresh();
	assert.deepEqual(managerA.list().map((s) => s.id), [a.id]);
	assert.deepEqual(managerB.list().map((s) => s.id), [b.id]);
});

test("all-project managers discover and order valid sessions from every cwd", () => {
	const server = fakeServer();
	const managerZ = new AppManager("/tmp/z", server.run);
	const managerA = new AppManager("/tmp/a", server.run);
	const z = managerZ.start("btop");
	const a = managerA.start("lazygit");
	const all = AppManager.all("/tmp/unused", server.run);

	all.refresh();
	assert.deepEqual(managerZ.list().map((session) => session.id), [z.id]);
	assert.deepEqual(managerA.list().map((session) => session.id), [a.id]);
	assert.deepEqual(all.list(), [a, z]);
});

test("a fresh manager instance rediscovers existing sessions", () => {
	const server = fakeServer();
	const first = new AppManager("/tmp", server.run);
	const snap = first.start("btop");

	const second = new AppManager("/tmp", server.run);
	second.refresh();
	assert.equal(second.get(snap.id)?.label, "btop");
	assert.equal(second.size(), 1);
});

test("no private server means an empty list, not an error", () => {
	const server = fakeServer();
	for (const manager of [
		new AppManager("/tmp", server.run),
		AppManager.all("/tmp", server.run),
	]) {
		manager.refresh();
		assert.deepEqual(manager.list(), []);
		assert.equal(manager.size(), 0);
	}
});

test("foreign, malformed, and other-project rows are hidden", () => {
	const cwd = canonicalCwd("/tmp");
	const rows = [
		`user-session\t100\t1\t${encode(cwd)}\t${encode("vim")}`, // not manager-owned
		`pi-app-00000001\t100\t0\tnot!base64\t${encode("bad")}`, // malformed cwd
		`pi-app-00000002\t100\t0\t${encode("/elsewhere")}\t${encode("other")}`, // other project
		`pi-app-00000003\tNaN\t0\t${encode(cwd)}\t${encode("bad-time")}`, // bad timestamp
		`pi-app-00000004\t100\t0\t${encode(cwd)}`, // missing field
		`pi-app-00000005\t200\t1\t${encode(cwd)}\t${encode("good")}`,
	];
	const manager = new AppManager("/tmp", () => ({
		status: 0,
		stdout: `${rows.join("\n")}\n`,
		stderr: "",
	}));
	manager.refresh();
	assert.deepEqual(manager.list(), [
		{
			id: "pi-app-00000005",
			label: "good",
			cwd,
			createdAt: 200_000,
			attached: 1,
		},
	]);
});

test("global listing still hides foreign and malformed rows", () => {
	const cwd = canonicalCwd("/tmp");
	const other = canonicalCwd("/elsewhere");
	const rows = [
		`user-session\t100\t1\t${encode(cwd)}\t${encode("vim")}`,
		`pi-app-invalid\t100\t0\t${encode(cwd)}\t${encode("bad-id")}`,
		`pi-app-00000001\t100\t0\tnot!base64\t${encode("bad-meta")}`,
		`pi-app-00000002\tNaN\t0\t${encode(cwd)}\t${encode("bad-time")}`,
		`pi-app-00000003\t200\t1\t${encode(other)}\t${encode("good")}`,
	];
	const manager = AppManager.all("/tmp", () => ({
		status: 0,
		stdout: `${rows.join("\n")}\n`,
		stderr: "",
	}));
	manager.refresh();
	assert.deepEqual(manager.list(), [
		{
			id: "pi-app-00000003",
			label: "good",
			cwd: other,
			createdAt: 200_000,
			attached: 1,
		},
	]);
});

test("a genuine list failure throws a bounded error", () => {
	const run = () => ({ status: 1, stdout: "", stderr: "server exploded" });
	assert.throws(() => new AppManager("/tmp", run).refresh(), /server exploded/);
	assert.throws(() => AppManager.all("/tmp", run).refresh(), /server exploded/);
});

test("subscribers are notified on change and not on identical refreshes", () => {
	const server = fakeServer();
	const manager = new AppManager("/tmp", server.run);
	let notified = 0;
	manager.subscribe(() => notified++);

	manager.start("btop"); // internal refresh → 1
	assert.equal(notified, 1);
	manager.refresh(); // same content → no notification
	assert.equal(notified, 1);
	manager.kill(manager.list()[0].id); // refresh after kill → 2
	assert.equal(notified, 2);
	assert.equal(manager.size(), 0);
});

// --- Kill --------------------------------------------------------------------

test("global kill removes a known session from another project", () => {
	const server = fakeServer();
	const local = new AppManager("/tmp/local", server.run).start("btop");
	const foreign = new AppManager("/tmp/foreign", server.run).start("lazygit");
	const all = AppManager.all("/tmp/local", server.run);
	all.refresh();

	assert.throws(() => all.kill("pi-app-ffffffff"), /Unknown app session/);
	assert.throws(() => all.kill("not-an-app"), /Unknown app session/);
	assert.ok(!server.calls.some((call) => call.includes("=pi-app-ffffffff")));
	assert.ok(!server.calls.some((call) => call.includes("=not-an-app")));
	all.kill(foreign.id);
	assert.deepEqual(all.list().map((session) => session.id), [local.id]);
	assert.ok(server.sessions.has(local.id));
	assert.ok(!server.sessions.has(foreign.id));
});

test("kill removes a known session and validates ids first", () => {
	const server = fakeServer();
	const manager = new AppManager("/tmp", server.run);
	const snap = manager.start("btop");

	assert.throws(() => manager.kill("pi-app-ffffffff"), /Unknown app session/);
	assert.throws(() => manager.kill("evil; rm -rf /"), /Unknown app session/);
	// Malformed ids never reach tmux.
	assert.ok(!server.calls.some((c) => c.includes("=evil; rm -rf /")));

	manager.kill(snap.id);
	assert.equal(manager.size(), 0);
	assert.ok(server.calls.some((c) => c[2] === "kill-session" && c.includes(`=${snap.id}`)));
});

test("killing a session that already vanished is not an error", () => {
	const server = fakeServer();
	const manager = new AppManager("/tmp", server.run);
	const snap = manager.start("btop");
	server.sessions.clear(); // vanished behind our back
	manager.kill(snap.id);
	assert.equal(manager.size(), 0);
});

test("a genuine kill failure throws", () => {
	const server = fakeServer();
	const manager = new AppManager("/tmp", server.run);
	const snap = manager.start("btop");
	const run: TmuxRunner = (argv) =>
		argv[2] === "kill-session"
			? { status: 1, stdout: "", stderr: "kill refused" }
			: server.run(argv);
	const broken = new AppManager("/tmp", run);
	broken.refresh();
	assert.throws(() => broken.kill(snap.id), /kill refused/);
});

// --- Attach argv -------------------------------------------------------------

test("attachArgs validates the id and builds exact argv", () => {
	const manager = new AppManager("/tmp", fakeServer().run);
	assert.deepEqual(manager.attachArgs("pi-app-0a1b2c3d"), [
		"-L",
		"pi-apps",
		"attach-session",
		"-t",
		"=pi-app-0a1b2c3d",
	]);
	assert.throws(() => manager.attachArgs("pi-app-XYZ"), AppManagerError);
	assert.throws(() => manager.attachArgs("$(reboot)"), AppManagerError);
});
