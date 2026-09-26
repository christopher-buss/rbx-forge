import path from "node:path";

import type { FileSystem } from "../seams/file-system.ts";
import { studioLockPath } from "./lock-file.ts";

/** How many snapshots `forge open` keeps: the newest ones. */
export const SNAPSHOT_KEEP_COUNT = 5;

/** A place file: Studio opens `.rbxl` and `.rbxlx`. */
const PLACE_FILE = /\.rbxlx?$/i;
const ISO_TAIL = /Z$/;
const TIME_MARKS = /[.:]/g;

/** What pruning did. */
export interface SnapshotPrune {
	/** The snapshots it deleted, as absolute paths. */
	pruned: Array<string>;
	/** One message for each snapshot it could not delete. */
	warnings: Array<string>;
}

/**
 * The file name of a new snapshot: the time, then the place's name, so names
 * sort by time.
 *
 * @param now - The time, in ms since the epoch.
 * @param place - The place the snapshot copies.
 * @returns Such as `2026-09-26T10-15-00-123_game.rbxl`.
 */
export function snapshotName(now: number, place: string): string {
	const date = new Date(now);
	const time = date.toISOString().replace(ISO_TAIL, "").replaceAll(TIME_MARKS, "-");
	return `${time}_${path.basename(place)}`;
}

/**
 * The snapshots in a folder, oldest first.
 *
 * @param fileSystem - Reads the folder.
 * @param directory - `.forge/snapshots`.
 * @returns Their absolute paths; none when the folder does not exist.
 */
export function listSnapshots(
	fileSystem: Pick<FileSystem, "existsSync" | "readdirSync">,
	directory: string,
): Array<string> {
	if (!fileSystem.existsSync(directory)) {
		return [];
	}

	return fileSystem
		.readdirSync(directory)
		.filter((name) => PLACE_FILE.test(name))
		.toSorted()
		.map((name) => path.join(directory, name));
}

/**
 * Delete the snapshots older than the {@link SNAPSHOT_KEEP_COUNT} newest. A
 * snapshot with a Studio lock file stays: a Studio has it open.
 *
 * @param fileSystem - Reads the folder and deletes files.
 * @param directory - `.forge/snapshots`.
 * @returns What it deleted, and what it could not.
 */
export function pruneSnapshots(
	fileSystem: Pick<FileSystem, "existsSync" | "readdirSync" | "rmSync">,
	directory: string,
): SnapshotPrune {
	const snapshots = listSnapshots(fileSystem, directory);
	const old = snapshots.slice(0, Math.max(0, snapshots.length - SNAPSHOT_KEEP_COUNT));
	const result: SnapshotPrune = { pruned: [], warnings: [] };
	for (const snapshot of old) {
		// A Studio has it open.
		if (fileSystem.existsSync(studioLockPath(snapshot))) {
			continue;
		}

		try {
			fileSystem.rmSync(snapshot);
			result.pruned.push(snapshot);
		} catch (err) {
			result.warnings.push(`Could not delete ${snapshot}: ${String(err)}`);
		}
	}

	return result;
}
