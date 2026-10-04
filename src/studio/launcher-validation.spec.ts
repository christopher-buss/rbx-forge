import path from "node:path";
import { describe, expect, it } from "vitest";

import { createFakeSpawner } from "../../test/helpers/fake-process.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import { createMemoryFileSystem, createTestSeams, PROJECT } from "../../test/helpers/seams.ts";
import { createStudioLauncher } from "./launcher.ts";

function hiddenSessionLauncher() {
	const memory = createMemoryFileSystem({ "RobloxStudioBeta.exe": "" });
	const native = createFakeNative({
		42: {
			alive: true,
			desktop: "hidden",
			executablePath: "RobloxStudioBeta.exe",
			startTime: "42",
		},
	});
	const seams = createTestSeams({
		fileSystem: memory.fileSystem,
		host: { ...createTestSeams().host, platform: "win32" },
		native: () => native.addon,
	});
	const launches = { [path.join(PROJECT, "RobloxStudioBeta.exe")]: 42 };
	native.addon.spawnDetached = ({ program }) => launches[program] ?? null;
	return createStudioLauncher(seams, "/forge/supervisor.mjs");
}

describe("studio desktop reporting", () => {
	it.for([undefined, false])(
		"opens hidden session Studio when the snapshot watcher is disabled (%s)",
		async (watchHiddenLighting) => {
			expect.assertions(1);

			const launch = hiddenSessionLauncher();

			await expect(
				launch({
					cwd: PROJECT,
					desktop: "hidden",
					env: {},
					place: path.join(PROJECT, "game.rbxl"),
					studioPath: path.join(PROJECT, "RobloxStudioBeta.exe"),
					watchHiddenLighting,
				}),
			).resolves.toStrictEqual({
				studio: { desktop: "hidden", pid: 42, startTime: "42" },
				type: "launched",
			});
		},
	);

	it("leaves a failed snapshot launch as a failure without starting a watcher", async () => {
		expect.assertions(1);

		const seams = createTestSeams();

		await expect(
			createStudioLauncher(
				seams,
				"/forge/supervisor.mjs",
			)({
				cwd: PROJECT,
				desktop: "hidden",
				env: {},
				place: path.join(PROJECT, "game.rbxl"),
				studioPath: path.join(PROJECT, "missing.exe"),
				watchHiddenLighting: true,
			}),
		).resolves.toMatchObject({ type: "failed" });
	});

	it("falls back with actual user-desktop metadata when hidden desktop setup is unavailable", async () => {
		expect.assertions(1);

		const memory = createMemoryFileSystem({ "RobloxStudioBeta.exe": "" });
		const native = createFakeNative();
		native.addon.spawnDetached = () => null;
		const seams = createTestSeams({
			childProcess: createFakeSpawner().runner,
			fileSystem: memory.fileSystem,
			host: { ...createTestSeams().host, platform: "win32" },
			native: () => native.addon,
		});

		await expect(
			createStudioLauncher(
				seams,
				"/forge/supervisor.mjs",
			)({
				cwd: PROJECT,
				desktop: "hidden",
				env: {},
				place: path.join(PROJECT, "game.rbxl"),
				studioPath: path.join(PROJECT, "RobloxStudioBeta.exe"),
				watchHiddenLighting: true,
			}),
		).resolves.toStrictEqual({
			desktop: "user",
			type: "launched",
			warning:
				"Studio opened on the user's desktop: the platform launcher cannot use the hidden desktop.",
		});
	});

	it("preserves a native launch error without attempting another Studio launch", async () => {
		expect.assertions(1);

		const memory = createMemoryFileSystem({ "RobloxStudioBeta.exe": "" });
		const native = createFakeNative();
		native.addon.spawnDetached = () => {
			throw new Error("native launch failed");
		};

		const seams = createTestSeams({
			fileSystem: memory.fileSystem,
			host: { ...createTestSeams().host, platform: "win32" },
			native: () => native.addon,
		});

		await expect(
			createStudioLauncher(
				seams,
				"/forge/supervisor.mjs",
			)({
				cwd: PROJECT,
				desktop: "hidden",
				env: {},
				place: path.join(PROJECT, "game.rbxl"),
				studioPath: path.join(PROJECT, "RobloxStudioBeta.exe"),
			}),
		).rejects.toThrow("native launch failed");
	});

	it.for(["hidden", "user"] as const)(
		"reports the actual user desktop when the platform launcher receives a %s request",
		async (desktop) => {
			expect.assertions(1);

			const seams = createTestSeams({ childProcess: createFakeSpawner().runner });
			const launch = createStudioLauncher(seams, "/forge/supervisor.mjs");

			await expect(
				launch({ cwd: PROJECT, desktop, env: {}, place: path.join(PROJECT, "game.rbxl") }),
			).resolves.toStrictEqual({ desktop: "user", type: "launched" });
		},
	);

	it("keeps an unspecified platform-launch desktop out of the optional result metadata", async () => {
		expect.assertions(1);

		const seams = createTestSeams({ childProcess: createFakeSpawner().runner });
		const launch = createStudioLauncher(seams, "/forge/supervisor.mjs");

		await expect(
			launch({ cwd: PROJECT, env: {}, place: path.join(PROJECT, "game.rbxl") }),
		).resolves.toStrictEqual({ type: "launched" });
	});

	it("reports a direct Linux launch on the user desktop when hidden desktops are unavailable", async () => {
		expect.assertions(1);

		const studioPath = path.join(PROJECT, "Studio");
		const memory = createMemoryFileSystem({ Studio: "" });
		const native = createFakeNative({ 1000: { alive: true, executablePath: studioPath } });
		const seams = createTestSeams({
			childProcess: createFakeSpawner().runner,
			fileSystem: memory.fileSystem,
			native: () => native.addon,
		});
		const launch = createStudioLauncher(seams, "/forge/supervisor.mjs");

		await expect(
			launch({
				cwd: PROJECT,
				desktop: "hidden",
				env: {},
				place: path.join(PROJECT, "game.rbxl"),
				studioPath,
			}),
		).resolves.toMatchObject({
			studio: { desktop: "user", pid: 1000 },
			type: "launched",
		});
	});
});
