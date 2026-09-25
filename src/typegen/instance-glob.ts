import assert from "node:assert/strict";

/** An instance's path: its name and every ancestor's, service first. */
export type InstancePath = ReadonlyArray<string>;

/** Tests an instance path against one compiled pattern. */
export type InstanceGlob = (path: InstancePath) => boolean;

/** A `**` segment: any number of instance levels, none included. */
const GLOBSTAR = "**";

/**
 * Compile a glob over instance paths, such as `ReplicatedStorage/Assets/**`.
 * `/` separates instance levels; the path is matched level by level, so a
 * name that contains `/` is still one level.
 *
 * - `**` as a whole level matches any number of levels, none included.
 * - `*` matches any run of characters within one level, `?` exactly one.
 * - Every other character matches itself. Names that start with `.` are not
 *   special.
 *
 * @param pattern - Levels separated by `/`, such as `Workspace/**`.
 * @returns A test for instance paths.
 */
export function compileInstanceGlob(pattern: string): InstanceGlob {
	const levels = pattern.split("/").map((level) => {
		return level === GLOBSTAR ? GLOBSTAR : levelExpression(level);
	});

	return (path) => matchesFrom(levels, 0, path, 0);
}

/**
 * One level of a pattern as an anchored expression. Literal characters are
 * written as code point escapes, so none has a meaning in the expression.
 *
 * @param level - One level of the pattern.
 * @returns An expression that matches the whole name.
 */
function levelExpression(level: string): RegExp {
	const source = Array.from(level, (character) => {
		if (character === "*") {
			return "[^]*";
		}

		if (character === "?") {
			return "[^]";
		}

		const codePoint = character.codePointAt(0);
		// `Array.from` yields whole code points, never an empty string.
		assert(codePoint !== undefined);
		return `\\u{${codePoint.toString(16)}}`;
	}).join("");

	return new RegExp(`^${source}$`, "u");
}

function matchesFrom(
	levels: ReadonlyArray<RegExp | typeof GLOBSTAR>,
	levelIndex: number,
	path: InstancePath,
	pathIndex: number,
): boolean {
	const level = levels[levelIndex];
	if (level === undefined) {
		return pathIndex === path.length;
	}

	const name = path[pathIndex];
	if (level === GLOBSTAR) {
		return (
			matchesFrom(levels, levelIndex + 1, path, pathIndex) ||
			(name !== undefined && matchesFrom(levels, levelIndex, path, pathIndex + 1))
		);
	}

	return (
		name !== undefined &&
		level.test(name) &&
		matchesFrom(levels, levelIndex + 1, path, pathIndex + 1)
	);
}
