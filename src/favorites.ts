import {
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { deriveLabel } from "./manager.ts";

export interface AppFavorite {
	readonly command: string;
	readonly label: string;
}

interface FavoritesFile {
	favorites: string[];
}

export class FavoriteStore {
	readonly path: string;

	constructor(
		path = join(
			process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
			"interactive-apps.json",
		),
	) {
		this.path = path;
	}

	list(): AppFavorite[] {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.path, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw new Error(`Could not read favorites from ${this.path}: ${error}`);
		}

		const favorites = (parsed as Partial<FavoritesFile>)?.favorites;
		if (!Array.isArray(favorites) || favorites.some((item) => typeof item !== "string")) {
			throw new Error(`Invalid favorites file: ${this.path}`);
		}

		return [...new Set(favorites.map((command) => command.trim()))]
			.filter((command) => command && !command.includes("\u0000"))
			.map((command) => ({ command, label: deriveLabel(command) }));
	}

	// ponytail: concurrent Pi processes are last-writer-wins; add a file lock if that becomes common.
	add(command: string): boolean {
		const trimmed = command.trim();
		if (!trimmed) throw new Error("No favorite command to add.");
		if (trimmed.includes("\u0000")) throw new Error("Command contains a NUL byte.");
		const commands = this.list().map((favorite) => favorite.command);
		if (commands.includes(trimmed)) return false;
		this.write([...commands, trimmed]);
		return true;
	}

	remove(command: string): boolean {
		const commands = this.list().map((favorite) => favorite.command);
		const next = commands.filter((favorite) => favorite !== command);
		if (next.length === commands.length) return false;
		this.write(next);
		return true;
	}

	private write(favorites: string[]): void {
		mkdirSync(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.${process.pid}.tmp`;
		try {
			writeFileSync(temporary, `${JSON.stringify({ favorites }, null, 2)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			renameSync(temporary, this.path);
		} catch (error) {
			try {
				unlinkSync(temporary);
			} catch {}
			throw new Error(`Could not save favorites to ${this.path}: ${error}`);
		}
	}
}
