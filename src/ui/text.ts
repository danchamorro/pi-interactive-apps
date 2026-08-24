/**
 * Minimal ANSI-aware text helpers, local so the extension (and its tests)
 * have zero runtime dependencies. Only SGR sequences (\x1b[...m) are
 * recognized because that is all the theme emits.
 */

const SGR_SPLIT_RE = /(\u001b\[[0-9;:]*m)/;
const SGR_ALL_RE = /\u001b\[[0-9;:]*m/g;

/** Collapse whitespace/control characters into single spaces; one-line-safe. */
export function oneLine(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text
		.replace(SGR_ALL_RE, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Display width, ignoring SGR sequences. ponytail: counts every code point
 * as width 1; wide CJK/emoji labels may overflow a cell — swap in a real
 * width table if that ever matters. */
export function visibleWidth(text: string): number {
	return [...text.replace(SGR_ALL_RE, "")].length;
}

/** Truncate to `width` visible cells, preserving SGR sequences and closing
 * styles with a reset when styled text was cut. */
export function truncateToWidth(text: string, width: number): string {
	if (width <= 0) return "";
	let out = "";
	let used = 0;
	let styled = false;
	let truncated = false;
	for (const part of text.split(SGR_SPLIT_RE)) {
		if (part.startsWith("\u001b[")) {
			out += part;
			styled = true;
			continue;
		}
		if (truncated) continue;
		for (const ch of part) {
			if (used >= width) {
				truncated = true;
				break;
			}
			out += ch;
			used++;
		}
	}
	return truncated && styled ? `${out}\u001b[0m` : out;
}

/** Right-pad to exactly `width` visible cells (truncating when longer). */
export function padToWidth(text: string, width: number): string {
	const truncated = truncateToWidth(text, width);
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

/** Compact age like "42s", "5m", "3h", "2d". */
export function formatAge(createdAt: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.floor((now - createdAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}
