import path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem, PROJECT } from "../../test/helpers/seams.ts";
import { listSnapshots, pruneSnapshots, SNAPSHOT_KEEP_COUNT, snapshotName } from "./snapshots.ts";

const DIRECTORY = path.join(PROJECT, ".forge", "snapshots");

function snapshot(index: number): string {
	return `2026-09-26T10-00-0${index}-000_game.rbxl`;
}

function seed(
	count: number,
	extra: Record<string, string> = {},
	first = 0,
): Record<string, string> {
	const files: Record<string, string> = { ...extra };
	for (let index = first; index < first + count; index++) {
		files[`.forge/snapshots/${snapshot(index)}`] = "place";
	}

	return files;
}

function at(name: string): string {
	return path.join(DIRECTORY, name);
}

describe(snapshotName, () => {
	it("should name a snapshot by its time, then the place's name", () => {
		expect.assertions(1);

		expect(snapshotName(Date.UTC(2026, 8, 26, 10, 15, 0, 123), "places/game.rbxlx")).toBe(
			"2026-09-26T10-15-00-123_game.rbxlx",
		);
	});
});

describe(listSnapshots, () => {
	it("should list none when the folder does not exist", () => {
		expect.assertions(1);

		expect(listSnapshots(createMemoryFileSystem().fileSystem, DIRECTORY)).toStrictEqual([]);
	});

	it("should list place files oldest first, and skip lock files and others", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			".forge/snapshots/2026-09-26T10-00-01-000_game.rbxl": "place",
			".forge/snapshots/2026-09-26T10-00-01-000_game.rbxl.lock": "1",
			".forge/snapshots/2026-09-26T10-00-02-000_game.RBXLX": "place",
			".forge/snapshots/notes.txt": "",
		});

		expect(listSnapshots(fileSystem, DIRECTORY)).toStrictEqual([
			at("2026-09-26T10-00-01-000_game.rbxl"),
			at("2026-09-26T10-00-02-000_game.RBXLX"),
		]);
	});
});

describe(pruneSnapshots, () => {
	it(`should keep the ${SNAPSHOT_KEEP_COUNT} newest snapshots`, () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem(seed(SNAPSHOT_KEEP_COUNT + 2));

		expect(pruneSnapshots(fileSystem, DIRECTORY)).toStrictEqual({
			pruned: [at(snapshot(0)), at(snapshot(1))],
			warnings: [],
		});
		expect(listSnapshots(fileSystem, DIRECTORY)).toStrictEqual(
			[2, 3, 4, 5, 6].map((index) => at(snapshot(index))),
		);
	});

	it("should delete nothing with no more than the kept count", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem(seed(SNAPSHOT_KEEP_COUNT));

		expect(pruneSnapshots(fileSystem, DIRECTORY)).toStrictEqual({ pruned: [], warnings: [] });
	});

	it("should keep an old snapshot that a Studio has open", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem(
			seed(SNAPSHOT_KEEP_COUNT + 2, { [`.forge/snapshots/${snapshot(0)}.lock`]: "1" }),
		);

		expect(pruneSnapshots(fileSystem, DIRECTORY).pruned).toStrictEqual([at(snapshot(1))]);
		expect(fileSystem.existsSync(at(snapshot(0)))).toBeTrue();
	});

	it("should warn about a snapshot it cannot delete and go on", () => {
		expect.assertions(1);

		// A folder with a place's name: deleting it as a file fails.
		const { fileSystem } = createMemoryFileSystem(
			seed(SNAPSHOT_KEEP_COUNT + 1, { [`.forge/snapshots/${snapshot(0)}/inner`]: "" }, 1),
		);

		expect(pruneSnapshots(fileSystem, DIRECTORY)).toStrictEqual({
			pruned: [at(snapshot(1))],
			warnings: [expect.stringContaining(`Could not delete ${at(snapshot(0))}: `)],
		});
	});
});
