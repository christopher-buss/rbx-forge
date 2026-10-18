import path from "node:path";
import { describe, it } from "vitest";

import { createMemoryFileSystem, PROJECT } from "../../test/helpers/seams.ts";
import type { FileSystem } from "../seams/file-system.ts";
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

function denyRemoval(fileSystem: FileSystem, denied: string): FileSystem {
	return {
		...fileSystem,
		rmSync: (file, options) => {
			if (file === denied) {
				throw Object.assign(new Error("EACCES: access denied"), { code: "EACCES" });
			}

			fileSystem.rmSync(file, options);
		},
	};
}

describe(snapshotName, () => {
	it("should name a snapshot by its time, then the place's name", ({ expect }) => {
		expect.assertions(1);

		expect(snapshotName(Date.UTC(2026, 8, 26, 10, 15, 0, 123), "places/game.rbxlx")).toBe(
			"2026-09-26T10-15-00-123_game.rbxlx",
		);
	});
});

describe(listSnapshots, () => {
	it("should list none when the folder does not exist", ({ expect }) => {
		expect.assertions(1);

		expect(listSnapshots(createMemoryFileSystem().fileSystem, DIRECTORY)).toStrictEqual([]);
	});

	it("should list place files oldest first, and skip lock files and others", ({ expect }) => {
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
	it("keeps capture credentials and the launch script when the snapshot cannot be deleted", ({
		expect,
	}) => {
		expect.assertions(4);

		const place = at(snapshot(0));
		const { fileSystem } = createMemoryFileSystem(
			seed(SNAPSHOT_KEEP_COUNT + 1, {
				[`.forge/snapshots/${snapshot(0)}.capture.json`]: "credentials",
				[`.forge/snapshots/${snapshot(0)}.capture.lua`]: "marker",
			}),
		);

		expect(pruneSnapshots(denyRemoval(fileSystem, place), DIRECTORY)).toStrictEqual({
			pruned: [],
			warnings: [`Could not delete ${place}: Error: EACCES: access denied`],
		});
		expect(fileSystem.readFileSync(place, "utf8")).toBe("place");
		expect(fileSystem.readFileSync(`${place}.capture.json`, "utf8")).toBe("credentials");
		expect(fileSystem.readFileSync(`${place}.capture.lua`, "utf8")).toBe("marker");
	});

	it("removes a pruned snapshot's capture credentials and launch script", ({ expect }) => {
		expect.assertions(3);

		const { fileSystem } = createMemoryFileSystem(
			seed(SNAPSHOT_KEEP_COUNT + 1, {
				[`.forge/snapshots/${snapshot(0)}.capture.json`]: "credentials",
				[`.forge/snapshots/${snapshot(0)}.capture.lua`]: "marker",
			}),
		);

		expect(pruneSnapshots(fileSystem, DIRECTORY).pruned).toStrictEqual([at(snapshot(0))]);
		expect(fileSystem.existsSync(`${at(snapshot(0))}.capture.json`)).toBeFalse();
		expect(fileSystem.existsSync(`${at(snapshot(0))}.capture.lua`)).toBeFalse();
	});

	it(`should keep the ${SNAPSHOT_KEEP_COUNT} newest snapshots`, ({ expect }) => {
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

	it("should delete nothing with no more than the kept count", ({ expect }) => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem(seed(SNAPSHOT_KEEP_COUNT));

		expect(pruneSnapshots(fileSystem, DIRECTORY)).toStrictEqual({ pruned: [], warnings: [] });
	});

	it("should keep an old snapshot that a Studio has open", ({ expect }) => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem(
			seed(SNAPSHOT_KEEP_COUNT + 2, { [`.forge/snapshots/${snapshot(0)}.lock`]: "1" }),
		);

		expect(pruneSnapshots(fileSystem, DIRECTORY).pruned).toStrictEqual([at(snapshot(1))]);
		expect(fileSystem.existsSync(at(snapshot(0)))).toBeTrue();
	});

	it("should warn about a snapshot it cannot delete and go on", ({ expect }) => {
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
