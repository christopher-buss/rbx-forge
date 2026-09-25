import path from "node:path";

import type { AutoRecoveryMode } from "../config/schema.ts";
import { readVariable } from "../process/environment.ts";
import type { Clock } from "../seams/clock.ts";
import type { FileSystem } from "../seams/file-system.ts";
import type { Environment } from "../seams/seams.ts";

/** What forge did with the auto-recovery files. */
export interface RecoveryReport {
	/** The files it deleted. */
	deleted: Array<string>;
	mode: AutoRecoveryMode;
	/** The files it moved, and where to. */
	moved: Array<{ from: string; to: string }>;
	/** What failed; forge goes on without it. */
	warnings: Array<string>;
}

/** What one auto-recovery pass works on. */
export interface RecoveryTarget {
	/** The AutoSaves folders to search ({@link autoSaveDirectories}). */
	directories: ReadonlyArray<string>;
	mode: AutoRecoveryMode;
	/** The place Studio had open. */
	place: string;
	/** Where `move` puts the files: `.forge/recovery`. */
	recoveryDirectory: string;
	/** When the ended Studio started, in milliseconds since the epoch. */
	startedMs: number;
}

/** The seams auto-recovery handling runs with. */
export interface RecoverySeams {
	clock: Clock;
	fileSystem: Pick<
		FileSystem,
		| "copyFileSync"
		| "existsSync"
		| "mkdirSync"
		| "readdirSync"
		| "renameSync"
		| "rmSync"
		| "statSync"
		| "writeFileSync"
	>;
}

/** How many moved files `.forge/recovery` keeps: the newest. */
export const RECOVERY_KEEP_COUNT = 5;
/** How much earlier than Studio's start a file may be written. */
export const RECOVERY_SLACK_MS = 2000;
/** How often a busy file is tried again, and how long apart. */
export const RECOVERY_RETRIES = 20;
export const RECOVERY_RETRY_MS = 250;

/** Codes Windows gives for a file a killed process still holds. */
const BUSY_CODES: ReadonlySet<string> = new Set(["EACCES", "EBUSY", "EPERM"]);
const PLACE_EXTENSION = ".rbxl";
/** Milliseconds and the zone of an ISO time. */
const ISO_TAIL = /\.\d+Z$/;
const COLONS = /:/g;

/**
 * The folders Studio writes auto-recovery files to, current first. Studio
 * has moved the folder between versions, so both places count.
 *
 * - Windows: `%LOCALAPPDATA%\Roblox\RobloxStudio\AutoSaves` and
 *   `%USERPROFILE%\Documents\ROBLOX\AutoSaves`.
 * - macOS: `~/Library/Application Support/Roblox/RobloxStudio/AutoSaves` and
 *   `~/Documents/ROBLOX/AutoSaves`.
 * - Elsewhere: none; Studio does not run there.
 *
 * @param environment - Holds `LOCALAPPDATA` and `USERPROFILE`, or `HOME`.
 * @param platform - The OS.
 * @returns The folders; one whose variable is unset is left out.
 */
export function autoSaveDirectories(
	environment: Environment,
	platform: NodeJS.Platform,
): Array<string> {
	const folders: Array<string | undefined> = [];
	if (platform === "win32") {
		folders.push(
			under(environment, "LOCALAPPDATA", platform, ["Roblox", "RobloxStudio", "AutoSaves"]),
			under(environment, "USERPROFILE", platform, ["Documents", "ROBLOX", "AutoSaves"]),
		);
	} else if (platform === "darwin") {
		folders.push(
			under(environment, "HOME", platform, [
				"Library",
				"Application Support",
				"Roblox",
				"RobloxStudio",
				"AutoSaves",
			]),
			under(environment, "HOME", platform, ["Documents", "ROBLOX", "AutoSaves"]),
		);
	}

	return folders.filter((folder) => folder !== undefined);
}

/**
 * Handle the auto-recovery files a Studio that forge ended left behind.
 * Studio deletes them only when it closes by itself, so the next launch
 * would offer to recover a place forge builds anyway. Only the place's files
 * (`<place>_AutoRecovery_<n>.rbxl`, any case) written since the Studio
 * started count. A failure is a warning in the report; it never throws.
 *
 * @param seams - The file system and the clock (for retries).
 * @param target - The mode, place, folders, and start time.
 * @returns What it did.
 */
export async function handleAutoRecoveryAsync(
	seams: RecoverySeams,
	target: RecoveryTarget,
): Promise<RecoveryReport> {
	const report: RecoveryReport = { deleted: [], mode: target.mode, moved: [], warnings: [] };
	if (target.mode === "keep") {
		return report;
	}

	for (const file of findRecoveryFiles(seams, target, report)) {
		try {
			if (target.mode === "delete") {
				await retryAsync(seams, () => {
					seams.fileSystem.rmSync(file);
				});
				report.deleted.push(file);
			} else {
				report.moved.push(await moveAsync(seams, file, target.recoveryDirectory));
			}
		} catch (err) {
			report.warnings.push(`Could not ${target.mode} ${file}: ${messageOf(err)}`);
		}
	}

	if (report.moved.length > 0) {
		prune(seams, target.recoveryDirectory, report);
	}

	return report;
}

/**
 * A folder under the one a variable names.
 *
 * @param environment - Holds the variable.
 * @param name - Such as `HOME`.
 * @param platform - The OS; Windows paths join with `\`.
 * @param parts - The path below it.
 * @returns The folder; `undefined` when the variable is unset or empty.
 */
function under(
	environment: Environment,
	name: string,
	platform: NodeJS.Platform,
	parts: ReadonlyArray<string>,
): string | undefined {
	const root = readVariable(environment, name, platform);
	if (root === undefined || root === "") {
		return undefined;
	}

	return (platform === "win32" ? path.win32 : path.posix).join(root, ...parts);
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function codeOf(err: unknown): unknown {
	return err instanceof Error ? Reflect.get(err, "code") : undefined;
}

/**
 * Whether an error is Windows holding the file of a killed process.
 *
 * @param err - What a file call threw.
 * @returns True for `EACCES`, `EBUSY`, and `EPERM`.
 */
function isBusy(err: unknown): boolean {
	const code = codeOf(err);
	return typeof code === "string" && BUSY_CODES.has(code);
}

/**
 * Run `action`, again while Windows still holds the file of a killed
 * process.
 *
 * @param seams - The clock.
 * @param action - The file operation.
 * @rejects The last error, or any error that is not a busy file.
 */
async function retryAsync(seams: Pick<RecoverySeams, "clock">, action: () => void): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			action();
			return;
		} catch (err) {
			if (!isBusy(err) || attempt >= RECOVERY_RETRIES) {
				throw err;
			}

			await seams.clock.sleep(RECOVERY_RETRY_MS);
		}
	}
}

/**
 * The names in a folder. A missing folder has none; another failure is a
 * warning.
 *
 * @param seams - The file system.
 * @param directory - An AutoSaves or recovery folder.
 * @param report - Gets the warning.
 * @returns The names of its entries.
 */
function readNames(seams: RecoverySeams, directory: string, report: RecoveryReport): Array<string> {
	try {
		return seams.fileSystem.readdirSync(directory);
	} catch (err) {
		if (codeOf(err) !== "ENOENT") {
			report.warnings.push(`Could not read ${directory}: ${messageOf(err)}`);
		}

		// Stryker disable next-line ArrayDeclaration: equivalent, no filter
		// keeps a made-up name
		return [];
	}
}

/**
 * Whether a file in an AutoSaves folder is the place's, written since
 * Studio started.
 *
 * @param seams - The file system.
 * @param file - The file's path.
 * @param target - The start time.
 * @param report - Gets a warning when the file cannot be read.
 * @returns True when it counts.
 */
function isRecent(
	seams: RecoverySeams,
	file: string,
	target: RecoveryTarget,
	report: RecoveryReport,
): boolean {
	try {
		const stats = seams.fileSystem.statSync(file);
		return stats.isFile() && stats.mtimeMs >= target.startedMs - RECOVERY_SLACK_MS;
	} catch (err) {
		report.warnings.push(`Could not read ${file}: ${messageOf(err)}`);
		return false;
	}
}

/**
 * The place's auto-recovery files written since Studio started.
 *
 * @param seams - The file system.
 * @param target - The place, folders, and start time.
 * @param report - Gets a warning for a folder or file it cannot read.
 * @returns Their paths.
 */
function findRecoveryFiles(
	seams: RecoverySeams,
	target: RecoveryTarget,
	report: RecoveryReport,
): Array<string> {
	const base = path.basename(target.place, path.extname(target.place));
	const prefix = `${base}_AutoRecovery_`.toLowerCase();
	return target.directories.flatMap((directory) => {
		return readNames(seams, directory, report)
			.filter((name) => {
				const lower = name.toLowerCase();
				return lower.startsWith(prefix) && lower.endsWith(PLACE_EXTENSION);
			})
			.map((name) => path.join(directory, name))
			.filter((file) => isRecent(seams, file, target, report));
	});
}

/**
 * The name a moved file gets: its modification time, then its name, so
 * names sort by time.
 *
 * @param seams - The file system.
 * @param file - The auto-recovery file.
 * @returns Such as `2026-09-25T17-16-00_game_AutoRecovery_0.rbxl`.
 */
function movedName(seams: RecoverySeams, file: string): string {
	const written = new Date(seams.fileSystem.statSync(file).mtimeMs);
	const time = written.toISOString().replace(ISO_TAIL, "").replace(COLONS, "-");
	return `${time}_${path.basename(file)}`;
}

/**
 * Move a file into the recovery folder, with a copy and a delete across
 * drives.
 *
 * @param seams - The file system and clock.
 * @param file - The auto-recovery file.
 * @param directory - The recovery folder.
 * @returns Where it went.
 * @rejects When it cannot be moved.
 */
async function moveAsync(
	seams: RecoverySeams,
	file: string,
	directory: string,
): Promise<{ from: string; to: string }> {
	const { fileSystem } = seams;
	fileSystem.mkdirSync(directory, { recursive: true });
	const ignore = path.join(directory, ".gitignore");
	if (!fileSystem.existsSync(ignore)) {
		fileSystem.writeFileSync(ignore, "*\n");
	}

	const to = path.join(directory, movedName(seams, file));
	await retryAsync(seams, () => {
		try {
			fileSystem.renameSync(file, to);
		} catch (err) {
			if (codeOf(err) !== "EXDEV") {
				throw err;
			}

			fileSystem.copyFileSync(file, to);
			fileSystem.rmSync(file);
		}
	});
	return { from: file, to };
}

/**
 * Keep only the {@link RECOVERY_KEEP_COUNT} newest moved files.
 *
 * @param seams - The file system.
 * @param directory - The recovery folder.
 * @param report - Gets a warning when a delete fails.
 */
function prune(seams: RecoverySeams, directory: string, report: RecoveryReport): void {
	const names = readNames(seams, directory, report)
		.filter((name) => name.toLowerCase().endsWith(PLACE_EXTENSION))
		.toSorted();
	const old = names.slice(0, Math.max(0, names.length - RECOVERY_KEEP_COUNT));
	for (const name of old) {
		const file = path.join(directory, name);
		try {
			seams.fileSystem.rmSync(file);
		} catch (err) {
			report.warnings.push(`Could not delete ${file}: ${messageOf(err)}`);
		}
	}
}
