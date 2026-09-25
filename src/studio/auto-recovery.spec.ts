import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { MemoryFileSystem } from "../../test/helpers/seams.ts";
import { createMemoryFileSystem, PROJECT } from "../../test/helpers/seams.ts";
import type { Clock } from "../seams/clock.ts";
import type { RecoverySeams, RecoveryTarget } from "./auto-recovery.ts";
import {
	autoSaveDirectories,
	handleAutoRecoveryAsync,
	RECOVERY_KEEP_COUNT,
	RECOVERY_RETRIES,
	RECOVERY_RETRY_MS,
	RECOVERY_SLACK_MS,
} from "./auto-recovery.ts";

/** When the ended Studio started. */
const STARTED = Date.UTC(2026, 8, 25, 17, 0, 0);
const SAVES = path.join(PROJECT, "AutoSaves");
const OLD_SAVES = path.join(PROJECT, "Documents", "AutoSaves");
const RECOVERY = path.join(PROJECT, ".forge", "recovery");

interface World {
	memory: MemoryFileSystem;
	seams: RecoverySeams;
	/** Every sleep, in order. */
	sleeps: Array<number>;
}

function makeWorld(): World {
	const memory = createMemoryFileSystem();
	const sleeps: Array<number> = [];
	const clock: Clock = {
		now: () => 0,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	};
	return { memory, seams: { clock, fileSystem: memory.fileSystem }, sleeps };
}

/**
 * Write a file with a modification time.
 *
 * @param world - The file system.
 * @param file - Its absolute path.
 * @param mtimeMs - When it was written.
 */
function writeAt(world: World, file: string, mtimeMs: number): void {
	world.memory.fileSystem.mkdirSync(path.dirname(file), { recursive: true });
	world.memory.fileSystem.writeFileSync(file, path.basename(file));
	world.memory.setModifiedTime(path.relative(PROJECT, file), mtimeMs);
}

function targetOf(overrides: Partial<RecoveryTarget> = {}): RecoveryTarget {
	return {
		directories: [SAVES, OLD_SAVES],
		mode: "move",
		place: path.join(PROJECT, "game.rbxl"),
		recoveryDirectory: RECOVERY,
		startedMs: STARTED,
		...overrides,
	};
}

/**
 * Make one file system call throw, as a busy or cross-drive file does.
 *
 * @param world - The file system.
 * @param call - The call to break.
 * @param codes - The error code of each failing call, in order; later calls
 *   work.
 */
function failCalls(
	world: World,
	call: "readdirSync" | "renameSync" | "rmSync" | "statSync",
	codes: Array<string>,
): void {
	const { fileSystem } = world.seams;
	const original: (...args: Array<never>) => unknown = fileSystem[call];
	const failing = vi.fn<(...args: Array<never>) => unknown>((...args) => {
		const code = codes.shift();
		if (code !== undefined) {
			throw Object.assign(new Error(`${call} failed: ${code}`), { code });
		}

		return original(...args);
	});
	world.seams = { ...world.seams, fileSystem: { ...fileSystem, [call]: failing } };
}

describe(autoSaveDirectories, () => {
	it("should give both Windows folders", () => {
		expect.assertions(1);

		expect(
			autoSaveDirectories(
				{ localappdata: String.raw`C:\L`, USERPROFILE: String.raw`C:\U` },
				"win32",
			),
		).toStrictEqual([
			String.raw`C:\L\Roblox\RobloxStudio\AutoSaves`,
			String.raw`C:\U\Documents\ROBLOX\AutoSaves`,
		]);
	});

	it("should give both macOS folders", () => {
		expect.assertions(1);

		expect(autoSaveDirectories({ HOME: "/Users/me" }, "darwin")).toStrictEqual([
			"/Users/me/Library/Application Support/Roblox/RobloxStudio/AutoSaves",
			"/Users/me/Documents/ROBLOX/AutoSaves",
		]);
	});

	it("should leave out a folder whose variable is unset or empty, and give none on Linux", () => {
		expect.assertions(3);

		expect(
			autoSaveDirectories({ LOCALAPPDATA: "", USERPROFILE: "C:\\U" }, "win32"),
		).toStrictEqual([String.raw`C:\U\Documents\ROBLOX\AutoSaves`]);
		expect(autoSaveDirectories({}, "darwin")).toStrictEqual([]);
		expect(autoSaveDirectories({ HOME: "/home/me" }, "linux")).toStrictEqual([]);
	});
});

describe(handleAutoRecoveryAsync, () => {
	it("should move the place's files from this Studio run, in any case, from both folders", async () => {
		expect.assertions(2);

		const world = makeWorld();
		writeAt(world, path.join(SAVES, "game_AutoRecovery_0.rbxl"), STARTED + 60_000);
		writeAt(
			world,
			path.join(OLD_SAVES, "GAME_autorecovery_1.RBXL"),
			STARTED - RECOVERY_SLACK_MS,
		);

		await expect(handleAutoRecoveryAsync(world.seams, targetOf())).resolves.toStrictEqual({
			deleted: [],
			mode: "move",
			moved: [
				{
					from: path.join(SAVES, "game_AutoRecovery_0.rbxl"),
					to: path.join(RECOVERY, "2026-09-25T17-01-00_game_AutoRecovery_0.rbxl"),
				},
				{
					from: path.join(OLD_SAVES, "GAME_autorecovery_1.RBXL"),
					to: path.join(RECOVERY, "2026-09-25T16-59-58_GAME_autorecovery_1.RBXL"),
				},
			],
			warnings: [],
		});
		expect(world.memory.files()).toStrictEqual({
			".forge/recovery/2026-09-25T16-59-58_GAME_autorecovery_1.RBXL":
				"GAME_autorecovery_1.RBXL",
			".forge/recovery/2026-09-25T17-01-00_game_AutoRecovery_0.rbxl":
				"game_AutoRecovery_0.rbxl",
			".forge/recovery/.gitignore": "*\n",
			"AutoSaves": null,
			"Documents/AutoSaves": null,
		});
	});

	it("should leave older files, other places, and other files alone", async () => {
		expect.assertions(2);

		const world = makeWorld();
		const kept = [
			path.join(SAVES, "game_AutoRecovery_0.rbxl"),
			path.join(SAVES, "other_AutoRecovery_0.rbxl"),
			path.join(SAVES, "game_AutoRecovery_0.rbxl.tmp"),
			path.join(SAVES, "endgame_AutoRecovery_0.rbxl"),
		];
		writeAt(world, kept[0]!, STARTED - RECOVERY_SLACK_MS - 1);
		for (const file of kept.slice(1)) {
			writeAt(world, file, STARTED);
		}

		world.memory.fileSystem.mkdirSync(path.join(SAVES, "game_AutoRecovery_9.rbxl"));

		await expect(handleAutoRecoveryAsync(world.seams, targetOf())).resolves.toMatchObject({
			moved: [],
			warnings: [],
		});
		expect(kept.every((file) => world.memory.fileSystem.existsSync(file))).toBeTrue();
	});

	it("should keep a .gitignore the recovery folder already has", async () => {
		expect.assertions(1);

		const world = makeWorld();
		writeAt(world, path.join(RECOVERY, ".gitignore"), STARTED);
		writeAt(world, path.join(SAVES, "game_AutoRecovery_0.rbxl"), STARTED);
		await handleAutoRecoveryAsync(world.seams, targetOf());

		expect(world.memory.files()[".forge/recovery/.gitignore"]).toBe(".gitignore");
	});

	it("should delete the files in delete mode", async () => {
		expect.assertions(2);

		const world = makeWorld();
		const file = path.join(SAVES, "game_AutoRecovery_0.rbxl");
		writeAt(world, file, STARTED);

		await expect(
			handleAutoRecoveryAsync(world.seams, targetOf({ mode: "delete" })),
		).resolves.toStrictEqual({ deleted: [file], mode: "delete", moved: [], warnings: [] });
		expect(world.memory.files()).toStrictEqual({ AutoSaves: null });
	});

	it("should touch nothing in keep mode", async () => {
		expect.assertions(2);

		const world = makeWorld();
		const file = path.join(SAVES, "game_AutoRecovery_0.rbxl");
		writeAt(world, file, STARTED);

		await expect(
			handleAutoRecoveryAsync(world.seams, targetOf({ mode: "keep" })),
		).resolves.toStrictEqual({ deleted: [], mode: "keep", moved: [], warnings: [] });
		expect(world.memory.fileSystem.existsSync(file)).toBeTrue();
	});

	it(`should keep only the ${RECOVERY_KEEP_COUNT} newest moved files`, async () => {
		expect.assertions(1);

		const world = makeWorld();
		for (let index = 0; index < RECOVERY_KEEP_COUNT; index++) {
			writeAt(
				world,
				path.join(RECOVERY, `2026-01-0${index + 1}T00-00-00_game_AutoRecovery_0.rbxl`),
				0,
			);
		}

		writeAt(world, path.join(RECOVERY, "notes.txt"), 0);
		writeAt(world, path.join(SAVES, "game_AutoRecovery_0.rbxl"), STARTED);
		await handleAutoRecoveryAsync(world.seams, targetOf());

		expect(
			Object.keys(world.memory.files())
				.filter((file) => file.startsWith(".forge"))
				.toSorted(),
		).toStrictEqual([
			".forge/recovery/.gitignore",
			".forge/recovery/2026-01-02T00-00-00_game_AutoRecovery_0.rbxl",
			".forge/recovery/2026-01-03T00-00-00_game_AutoRecovery_0.rbxl",
			".forge/recovery/2026-01-04T00-00-00_game_AutoRecovery_0.rbxl",
			".forge/recovery/2026-01-05T00-00-00_game_AutoRecovery_0.rbxl",
			".forge/recovery/2026-09-25T17-00-00_game_AutoRecovery_0.rbxl",
			".forge/recovery/notes.txt",
		]);
	});

	it("should try a busy file again until it moves", async () => {
		expect.assertions(2);

		const world = makeWorld();
		writeAt(world, path.join(SAVES, "game_AutoRecovery_0.rbxl"), STARTED);
		failCalls(world, "renameSync", ["EBUSY", "EPERM", "EACCES"]);

		await expect(handleAutoRecoveryAsync(world.seams, targetOf())).resolves.toMatchObject({
			moved: [{ from: path.join(SAVES, "game_AutoRecovery_0.rbxl") }],
			warnings: [],
		});
		expect(world.sleeps).toStrictEqual([
			RECOVERY_RETRY_MS,
			RECOVERY_RETRY_MS,
			RECOVERY_RETRY_MS,
		]);
	});

	it("should warn, and go on, when a file stays busy", async () => {
		expect.assertions(2);

		const world = makeWorld();
		const file = path.join(SAVES, "game_AutoRecovery_0.rbxl");
		writeAt(world, file, STARTED);
		failCalls(
			world,
			"rmSync",
			Array.from<string>({ length: RECOVERY_RETRIES + 1 }).fill("EBUSY"),
		);

		await expect(
			handleAutoRecoveryAsync(world.seams, targetOf({ mode: "delete" })),
		).resolves.toStrictEqual({
			deleted: [],
			mode: "delete",
			moved: [],
			warnings: [`Could not delete ${file}: rmSync failed: EBUSY`],
		});
		expect(world.sleeps).toHaveLength(RECOVERY_RETRIES);
	});

	it("should warn at once on an error that is not a busy file", async () => {
		expect.assertions(2);

		const world = makeWorld();
		const file = path.join(SAVES, "game_AutoRecovery_0.rbxl");
		writeAt(world, file, STARTED);
		failCalls(world, "renameSync", ["ENOSPC"]);

		await expect(handleAutoRecoveryAsync(world.seams, targetOf())).resolves.toMatchObject({
			moved: [],
			warnings: [`Could not move ${file}: renameSync failed: ENOSPC`],
		});
		expect(world.sleeps).toStrictEqual([]);
	});

	it("should warn with a thrown value that is not an error", async () => {
		expect.assertions(1);

		const world = makeWorld();
		const file = path.join(SAVES, "game_AutoRecovery_0.rbxl");
		writeAt(world, file, STARTED);
		world.seams = {
			...world.seams,
			fileSystem: {
				...world.seams.fileSystem,
				renameSync: () => {
					// oxlint-disable-next-line typescript/only-throw-error -- a thrown value that is not an Error
					throw "locked";
				},
			},
		};

		await expect(handleAutoRecoveryAsync(world.seams, targetOf())).resolves.toMatchObject({
			warnings: [`Could not move ${file}: locked`],
		});
	});

	it("should copy and delete a file on another drive", async () => {
		expect.assertions(2);

		const world = makeWorld();
		const file = path.join(SAVES, "game_AutoRecovery_0.rbxl");
		writeAt(world, file, STARTED);
		failCalls(world, "renameSync", ["EXDEV"]);

		await expect(handleAutoRecoveryAsync(world.seams, targetOf())).resolves.toMatchObject({
			moved: [{ from: file }],
			warnings: [],
		});
		expect(world.memory.files()).toMatchObject({
			".forge/recovery/2026-09-25T17-00-00_game_AutoRecovery_0.rbxl":
				"game_AutoRecovery_0.rbxl",
			"AutoSaves": null,
		});
	});

	it("should warn about a folder or file it cannot read, and not about a missing folder", async () => {
		expect.assertions(1);

		const world = makeWorld();
		const file = path.join(OLD_SAVES, "game_AutoRecovery_0.rbxl");
		writeAt(world, file, STARTED);
		failCalls(world, "readdirSync", ["EACCES"]);
		failCalls(world, "statSync", ["EPERM"]);

		await expect(
			handleAutoRecoveryAsync(
				world.seams,
				targetOf({ directories: [SAVES, path.join(PROJECT, "missing"), OLD_SAVES] }),
			),
		).resolves.toMatchObject({
			moved: [],
			warnings: [
				`Could not read ${SAVES}: readdirSync failed: EACCES`,
				`Could not read ${file}: statSync failed: EPERM`,
			],
		});
	});

	it("should warn when it cannot prune an old moved file", async () => {
		expect.assertions(1);

		const world = makeWorld();
		for (let index = 0; index < RECOVERY_KEEP_COUNT; index++) {
			writeAt(
				world,
				path.join(RECOVERY, `2026-01-0${index + 1}T00-00-00_game_AutoRecovery_0.rbxl`),
				0,
			);
		}

		writeAt(world, path.join(SAVES, "game_AutoRecovery_0.rbxl"), STARTED);
		// The move's rename works; the prune's delete fails.
		failCalls(world, "rmSync", ["EPERM"]);

		await expect(handleAutoRecoveryAsync(world.seams, targetOf())).resolves.toMatchObject({
			warnings: [
				`Could not delete ${path.join(RECOVERY, "2026-01-01T00-00-00_game_AutoRecovery_0.rbxl")}: rmSync failed: EPERM`,
			],
		});
	});
});
