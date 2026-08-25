import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FavoriteStore } from "./src/favorites.ts";

test("favorites persist, deduplicate, remove, and reject malformed files", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-app-favorites-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "nested", "interactive-apps.json");
	const store = new FavoriteStore(path);

	assert.deepEqual(store.list(), []);
	assert.equal(store.add("  lazygit --path .  "), true);
	assert.equal(store.add("lazygit --path ."), false);
	assert.deepEqual(store.list(), [
		{ command: "lazygit --path .", label: "lazygit" },
	]);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
		favorites: ["lazygit --path ."],
	});
	assert.equal(store.remove("lazygit --path ."), true);
	assert.equal(store.remove("missing"), false);

	writeFileSync(path, '{"favorites":"wrong"}');
	assert.throws(() => store.list(), /Invalid favorites file/);
});
