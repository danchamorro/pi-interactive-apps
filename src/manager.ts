/**
 * AppManager — project-filtered registry of persistent interactive app
 * sessions backed by a private tmux server (`tmux -L pi-apps`).
 *
 * Every tmux invocation is synchronous (spawnSync) and built as argv — user
 * input is never concatenated into a shell command. The user's command
 * travels through a temporary tmux session environment variable that both
 * the launch wrapper and the manager remove after pane creation, so the full
 * command never persists in tmux state.
 *
 * Sessions intentionally outlive Pi: there is no shutdown cleanup here.
 * tmux is the source of truth; a fresh manager instance rediscovers
 * everything by listing the private server.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export interface AppSession {
	/** Manager-generated tmux session name, e.g. "pi-app-3fa9c210". */
	readonly id: string;
	/** Short display label derived from the leading executable token. */
	readonly label: string;
	/** Canonical project directory the app was started in. */
	readonly cwd: string;
	/** Session creation time (ms since epoch, from tmux). */
	readonly createdAt: number;
	/** Number of tmux clients currently attached. */
	readonly attached: number;
}

export interface TmuxResult {
	status: number | null;
	stdout: string;
	stderr: string;
	/** Set when tmux could not be executed at all (e.g. not installed). */
	error?: string;
}

/** Full tmux argv (including `-L pi-apps`) → result. Injectable for tests. */
export type TmuxRunner = (args: string[]) => TmuxResult;

export const SOCKET_NAME = "pi-apps";
export const SESSION_PREFIX = "pi-app-";
const SESSION_ID_RE = /^pi-app-[0-9a-f]{8}$/;

export const LIST_FORMAT =
	"#{session_name}\t#{session_created}\t#{session_attached}\t#{@pi_app_cwd}\t#{@pi_app_label}";

/**
 * Constant launch wrapper run by tmux's default `/bin/sh -c`. It copies the
 * temporary environment values into shell variables, unsets them so the app
 * never sees them, then replaces itself with the user's shell running the
 * command. The manager separately removes both values from the tmux session
 * environment after pane creation.
 */
export const LAUNCH_WRAPPER =
	'pi_app_cmd="$PI_APP_COMMAND"; pi_app_shell="${PI_APP_SHELL:-/bin/sh}"; ' +
	'unset PI_APP_COMMAND PI_APP_SHELL; exec "$pi_app_shell" -lc "$pi_app_cmd"';

export class AppManagerError extends Error {}

/** Symlink aliases of the same project directory must compare equal. */
export function canonicalCwd(cwd: string): string {
	try {
		return realpathSync(cwd);
	} catch {
		return resolve(cwd);
	}
}

/** Short, control-character-free label from the leading executable token. */
export function deriveLabel(command: string): string {
	const first = command.trim().split(/\s+/)[0] ?? "";
	const base = first.replace(/^.*\//, "");
	// eslint-disable-next-line no-control-regex
	const clean = base
		.replace(/\u001b\[[0-9;:]*[A-Za-z]/g, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
	return (clean || "app").slice(0, 32);
}

function encodeMeta(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

function decodeMeta(value: string): string | undefined {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
	const decoded = Buffer.from(value, "base64url").toString("utf8");
	return decoded.length > 0 ? decoded : undefined;
}

function defaultRunner(args: string[]): TmuxResult {
	const result = spawnSync("tmux", args, {
		encoding: "utf8",
		env: process.env,
	});
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		error: result.error?.message,
	};
}

const NO_SERVER_RE = /no server running|No such file or directory|error connecting/i;
const NO_SESSION_RE = /can't find session|session not found|no such session/i;

/** Synchronous read model + lifecycle operations for one project's apps. */
export class AppManager {
	readonly cwd: string;
	private readonly run: TmuxRunner;
	private snapshots: AppSession[] = [];
	private lastKey = "";
	private readonly listeners = new Set<() => void>();

	constructor(cwd: string, runner: TmuxRunner = defaultRunner) {
		this.cwd = canonicalCwd(cwd);
		this.run = runner;
	}

	private exec(args: string[]): TmuxResult {
		const result = this.run(["-L", SOCKET_NAME, ...args]);
		if (result.error) {
			throw new AppManagerError(
				`tmux is unavailable (${result.error}). Install tmux to use interactive apps.`,
			);
		}
		return result;
	}

	/** Start `command` in this project. Throws AppManagerError on failure. */
	start(command: string): AppSession {
		const trimmed = command.trim();
		if (!trimmed) throw new AppManagerError("No command to start.");
		if (trimmed.includes("\u0000")) {
			throw new AppManagerError("Command contains a NUL byte.");
		}
		const id = SESSION_PREFIX + randomBytes(4).toString("hex");
		const label = deriveLabel(trimmed);
		const shell = process.env.SHELL || "/bin/sh";

		const created = this.exec([
			"new-session",
			"-d",
			"-s",
			id,
			"-c",
			this.cwd,
			"-e",
			`PI_APP_COMMAND=${trimmed}`,
			"-e",
			`PI_APP_SHELL=${shell}`,
			LAUNCH_WRAPPER,
		]);
		if (created.status !== 0) {
			throw new AppManagerError(
				`Could not start "${label}": ${created.stderr.trim() || "tmux new-session failed"}`,
			);
		}

		// Server-wide, idempotent: tmux 3.2+ extended keys so modern key
		// combos reach the app. Failure is non-fatal.
		this.exec(["set-option", "-s", "extended-keys", "on"]);

		// Option/environment targets take the plain session name: tmux 3.6
		// rejects the "=" exact-match prefix for these commands. The id is
		// manager-generated and regex-validated, so prefix matching is safe.
		const setup: string[][] = [
			["set-option", "-t", id, "@pi_app_cwd", encodeMeta(this.cwd)],
			["set-option", "-t", id, "@pi_app_label", encodeMeta(label)],
			["set-option", "-t", id, "status-right", " Ctrl+B D detach "],
			["set-environment", "-t", id, "-u", "PI_APP_COMMAND"],
			["set-environment", "-t", id, "-u", "PI_APP_SHELL"],
		];
		for (const args of setup) {
			const result = this.exec(args);
			if (result.status !== 0) {
				if (NO_SESSION_RE.test(result.stderr)) {
					// The command exited before we could tag the session — a
					// normal race, not corruption.
					throw new AppManagerError(
						`"${label}" exited immediately after starting.`,
					);
				}
				this.exec(["kill-session", "-t", `=${id}`]);
				throw new AppManagerError(
					`Could not record app metadata: ${result.stderr.trim() || "tmux set-option failed"}`,
				);
			}
		}

		this.refresh();
		const snapshot = this.get(id);
		if (!snapshot) {
			throw new AppManagerError(`"${label}" exited immediately after starting.`);
		}
		return snapshot;
	}

	/** Re-list sessions from tmux; notifies subscribers only on change. */
	refresh(): void {
		const result = this.exec(["list-sessions", "-F", LIST_FORMAT]);
		let next: AppSession[] = [];
		if (result.status !== 0) {
			if (!NO_SERVER_RE.test(result.stderr)) {
				throw new AppManagerError(
					`Could not list app sessions: ${result.stderr.trim() || "tmux list-sessions failed"}`,
				);
			}
			// No private server yet — that simply means no apps.
		} else {
			next = this.parse(result.stdout);
		}
		next.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
		const key = JSON.stringify(next);
		if (key === this.lastKey) return;
		this.lastKey = key;
		this.snapshots = next;
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {
				// A broken UI listener must not corrupt manager state.
			}
		}
	}

	private parse(stdout: string): AppSession[] {
		const sessions: AppSession[] = [];
		for (const line of stdout.split("\n")) {
			if (!line) continue;
			const fields = line.split("\t");
			if (fields.length !== 5) continue;
			const [name, createdRaw, attachedRaw, cwdRaw, labelRaw] = fields;
			if (!SESSION_ID_RE.test(name)) continue; // not manager-owned
			const created = Number(createdRaw);
			const attached = Number(attachedRaw);
			if (!Number.isFinite(created) || !Number.isFinite(attached)) continue;
			const cwd = decodeMeta(cwdRaw);
			const label = decodeMeta(labelRaw);
			if (!cwd || !label) continue; // malformed metadata → hide, not crash
			if (cwd !== this.cwd) continue; // other project
			sessions.push({
				id: name,
				label,
				cwd,
				createdAt: created * 1000,
				attached,
			});
		}
		return sessions;
	}

	list(): ReadonlyArray<AppSession> {
		return this.snapshots;
	}

	get(id: string): AppSession | undefined {
		return this.snapshots.find((snap) => snap.id === id);
	}

	size(): number {
		return this.snapshots.length;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Kill one known, manager-owned session. Throws AppManagerError. */
	kill(id: string): void {
		if (!SESSION_ID_RE.test(id) || !this.get(id)) {
			throw new AppManagerError(`Unknown app session "${id}".`);
		}
		const result = this.exec(["kill-session", "-t", `=${id}`]);
		if (
			result.status !== 0 &&
			!NO_SESSION_RE.test(result.stderr) &&
			!NO_SERVER_RE.test(result.stderr)
		) {
			throw new AppManagerError(
				`Could not stop the app: ${result.stderr.trim() || "tmux kill-session failed"}`,
			);
		}
		this.refresh();
	}

	/** Validated argv for `tmux <argv>` to attach to one session. */
	attachArgs(id: string): string[] {
		if (!SESSION_ID_RE.test(id)) {
			throw new AppManagerError(`Invalid app session id "${id}".`);
		}
		return ["-L", SOCKET_NAME, "attach-session", "-t", `=${id}`];
	}
}
