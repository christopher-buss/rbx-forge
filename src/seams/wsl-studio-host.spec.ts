// cspell:words wslpath
import path from "node:path";
import { assert, describe, it } from "vitest";

import { createMemoryFileSystem, createTestSeams } from "../../test/helpers/seams.ts";
import { ForgeError } from "../errors.ts";
import type { HelperClient } from "../native/helper-client.ts";
import type { ProcessOutcome, ProcessSpec } from "../process/process-runner.ts";
import { closeStudioAsync, findPlaceStudioAsync } from "../studio/close-studio.ts";
import { saveStudioAsync } from "../studio/save-studio.ts";
import { createWslStudioHost } from "./wsl-studio-host.ts";

const WINDOWS = String.raw`D:\temp\agents\RobloxStudioBeta.exe`;
const IDENTITY = { helperArch: "x64", hostname: "WINDOWS", protocol: 1, windowsArch: "x64" };
const PIN = { pid: 707, pin: "held", startTime: "134116992000000000" };
const OK: ProcessOutcome = {
	durationMs: 1,
	exitCode: 0,
	outputTail: [],
	signal: null,
	type: "exited",
};

function setup(
	options: {
		alive?: boolean;
		blocked?: boolean;
		launchReply?: unknown;
		lockReply?: null | string;
		output?: string;
		probeReply?: unknown;
		registries?: Array<null | string>;
		registry?: null | string;
		result?: ProcessOutcome;
		startTime?: null | string;
	} = {},
) {
	const requests: Array<Record<string, unknown>> = [];
	const conversions: Array<ProcessSpec> = [];
	const memory = createMemoryFileSystem();
	for (const file of ["/project/Studio.exe", "/project/game.rbxl", "/project/script.lua"]) {
		memory.fileSystem.mkdirSync("/project", { recursive: true });
		memory.fileSystem.writeFileSync(file, "fixture");
	}

	let now = Date.UTC(2026, 0, 1);
	const seams = createTestSeams({
		clock: {
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			},
		},
		fileSystem: memory.fileSystem,
	});
	let isAlive = options.alive ?? true;
	let isLockHeld = false;
	const client: HelperClient = {
		identity: Promise.resolve(IDENTITY),
		requestAsync: async (request) => {
			requests.push(request);
			switch (request["op"]) {
				case "autoSaveDirectories": {
					return [WINDOWS];
				}
				case "dismissDialog": {
					return false;
				}
				case "executablePath": {
					return WINDOWS;
				}
				case "isAlive": {
					return isAlive;
				}
				case "isBlocked": {
					return options.blocked ?? false;
				}
				case "kill":
				case "requestClose": {
					isAlive = request["op"] === "requestClose" && options.blocked === true;
					return true;
				}
				case "launch": {
					return options.launchReply ?? PIN;
				}
				case "pin": {
					return PIN;
				}
				case "pluginsFolder": {
					return WINDOWS;
				}
				case "probeHttp": {
					return options.probeReply;
				}
				case "processStartTime": {
					return options.startTime === undefined ? PIN.startTime : options.startTime;
				}
				case "readRegistry": {
					return options.registries?.shift() ?? options.registry ?? null;
				}
				case "releaseLock": {
					isLockHeld = false;
					return true;
				}
				case "requestSave": {
					memory.fileSystem.writeFileSync("/project/game.rbxl", "saved place");
					return "requested";
				}
				case "saveMenuEnabled": {
					return true;
				}
				case "tryLockFile": {
					const lock = isLockHeld ? null : (options.lockReply ?? null);
					isLockHeld = lock !== null;
					return lock;
				}
				case "windowVisibility": {
					return "user";
				}
				default: {
					throw new Error(`Unexpected operation ${String(request["op"])}`);
				}
			}
		},
	};
	seams.processRunner = async (spec) => {
		conversions.push(spec);
		return (
			options.result ?? {
				...OK,
				outputTail: [
					options.output ?? (spec.args[0] === "-u" ? "/project/Studio.exe" : WINDOWS),
				],
			}
		);
	};

	seams.studioHost = createWslStudioHost(
		{ ...seams, environment: { PATH: "/fixture-bin" } },
		() => client,
	);
	return { ...memory, conversions, requests, seams };
}

describe("wsl Studio tracer", () => {
	it("holds and releases a Windows drive singleton through the helper", async ({ expect }) => {
		expect.assertions(3);

		const { seams } = setup({ lockReply: "held-lock" });
		const lock = await seams.studioHost.tryLockFileAsync("/project/lock");
		assert(lock !== null);

		expect(lock).toHaveProperty("releaseAsync");
		await expect(lock.releaseAsync()).resolves.toBeUndefined();
		await expect(seams.studioHost.tryLockFileAsync("/project/lock")).resolves.not.toBeNull();
	});

	it("does not ask Windows to lock a Linux filesystem path", async ({ expect }) => {
		expect.assertions(1);

		const { seams } = setup({
			lockReply: "held-lock",
			output: String.raw`\\wsl.localhost\Ubuntu\home\project\lock`,
		});

		expect(await seams.studioHost.tryLockFileAsync("/project/lock")).toBeNull();
	});

	it("reports the Windows Plugins folder as a Linux path", async ({ expect }) => {
		expect.assertions(1);

		const { seams } = setup({ output: "/project/new-plugins" });

		await expect(seams.studioHost.pluginsFolderAsync({})).resolves.toBe("/project/new-plugins");
	});

	it("saves the Windows place through its menu", async ({ expect }) => {
		expect.assertions(2);

		const { seams } = setup();
		seams.fileSystem.writeFileSync(
			"/project/game.rbxl.lock",
			"707\nRobloxStudioBeta\nWINDOWS\n",
		);

		await expect(
			saveStudioAsync(seams, { place: "/project/game.rbxl", process: PIN }),
		).resolves.toMatchObject({ bytes: 11, pid: 707 });
		expect(seams.fileSystem.readFileSync("/project/game.rbxl", "utf8")).toBe("saved place");
	});

	it("exposes menu state, save, and exact dialog operations on a Windows pin", async ({
		expect,
	}) => {
		expect.assertions(3);

		const { seams } = setup();
		const pin = await seams.studioHost.pinProcessAsync(707);
		assert(pin !== null);

		await expect(pin.saveMenuEnabledAsync(1000)).resolves.toBe(true);
		await expect(pin.requestSaveAsync()).resolves.toBe("requested");
		await expect(
			pin.dismissDialogAsync("Lighting Technology Migration", "Continue", "user"),
		).resolves.toBe(false);
	});

	it("accepts an absent Windows AutoSaves folder", async ({ expect }) => {
		expect.assertions(1);

		const { seams } = setup({ output: "/absent/AutoSaves" });

		await expect(seams.studioHost.autoSaveDirectoriesAsync({})).resolves.toEqual([
			"/absent/AutoSaves",
		]);
	});

	it("moves Windows recovery files across devices after a modal dialog blocks close", async ({
		expect,
	}) => {
		expect.assertions(2);

		const { seams } = setup({ blocked: true, output: "/project" });
		const file = "/project/game_AutoRecovery_0.rbxl";
		seams.fileSystem.writeFileSync(file, "recovery");
		seams.fileSystem.renameSync = () => {
			throw Object.assign(new Error("cross device"), { code: "EXDEV" });
		};

		await expect(
			closeStudioAsync(
				seams,
				{ place: "/project/game.rbxl", process: PIN },
				{ env: {}, mode: "move", recoveryDirectory: "/project/recovery" },
			),
		).resolves.toMatchObject({
			end: "dialog",
			recovery: {
				moved: [{ from: path.join("/project", "game_AutoRecovery_0.rbxl") }],
				warnings: [],
			},
		});
		expect(seams.fileSystem.existsSync(file)).toBe(false);
	});

	it("reads binary probe responses from the Windows helper", async ({ expect }) => {
		expect.assertions(1);

		const { seams } = setup({ probeReply: [0, 255, 42] });
		assert(seams.studioHost.probeHttpAsync !== undefined);

		await expect(seams.studioHost.probeHttpAsync(34872, "/api/rojo")).resolves.toEqual(
			new Uint8Array([0, 255, 42]),
		);
	});

	it("launches a Windows identity without passing Linux environment variables", async ({
		expect,
	}) => {
		expect.assertions(2);

		const { seams } = setup();
		const result = await seams.studioHost.launchAsync({
			beforeLaunch: async () => {},
			cwd: "/project",
			env: { HOME: "/linux", PATH: "/linux/bin" },
			place: "/project/game.rbxl",
			runScript: "/project/script.lua",
			studioPath: "/project/Studio.exe",
		});

		expect(result).toEqual({
			desktop: "user",
			studio: { desktop: "user", os: "win32", pid: 707, startTime: PIN.startTime },
			type: "launched",
		});
		expect(await seams.studioHost.processStartTimeAsync(707)).toBe(PIN.startTime);
	});

	it("launches a place without a RunScript or preparation callback", async ({ expect }) => {
		expect.assertions(1);

		const { seams } = setup();

		await expect(
			seams.studioHost.launchAsync({
				cwd: "/project",
				env: { RBX_FORGE_STUDIO_PATH: "/project/Studio.exe" },
				place: "/project/game.rbxl",
			}),
		).resolves.toHaveProperty("type", "launched");
	});

	it("finds the installed Windows executable", async ({ expect }) => {
		expect.assertions(1);

		const { seams } = setup({ registry: `"${WINDOWS}" %1` });

		await expect(seams.studioHost.findStudioExecutableAsync({ env: {} })).resolves.toEqual({
			path: "/project/Studio.exe",
			source: "registry",
		});
	});

	it("ignores a stale registry entry and finds the next installed Studio", async ({ expect }) => {
		expect.assertions(1);

		const { seams } = setup({ registries: ['"relative.exe" %1', `"${WINDOWS}" %1`] });

		await expect(seams.studioHost.findStudioExecutableAsync({ env: {} })).resolves.toEqual({
			path: "/project/Studio.exe",
			source: "registry",
		});
	});

	it.for([
		{
			env: { RBX_FORGE_STUDIO_PATH: "/missing.exe" },
			source: "flag",
			studioPath: "/project/Studio.exe",
		},
		{ env: { RBX_FORGE_STUDIO_PATH: "/missing.exe" }, source: "flag", studioPath: WINDOWS },
		{ env: {}, source: "flag", studioPath: String.raw`\\server\share\Studio.exe` },
		{ env: { RBX_FORGE_STUDIO_PATH: "/project/Studio.exe" }, source: "environment" },
		{ env: { RBX_FORGE_STUDIO_PATH: WINDOWS }, source: "environment" },
		{
			env: { RBX_FORGE_STUDIO_PATH: String.raw`\\server\share\Studio.exe` },
			source: "environment",
		},
	])("discovers explicit paths before the registry: %j", async (options, { expect }) => {
		expect.assertions(1);

		const { seams } = setup({ registry: '"missing.exe" %1' });

		await expect(seams.studioHost.findStudioExecutableAsync(options)).resolves.toEqual({
			path: "/project/Studio.exe",
			source: options.source,
		});
	});

	it.for([
		"/missing.exe",
		"D:relative.exe",
		String.raw`\rooted.exe`,
		"",
		"/project",
		"bad\n.exe",
	])("fails an invalid flag instead of using installed Studio: %j", async (file, { expect }) => {
		expect.assertions(1);

		const { seams } = setup({ registry: `"${WINDOWS}" %1` });

		await expect(
			seams.studioHost.findStudioExecutableAsync({
				env: { RBX_FORGE_STUDIO_PATH: "/project/Studio.exe" },
				studioPath: file,
			}),
		).rejects.toMatchObject({ code: "studio_launch_failed" });
	});

	it.for(["/missing.exe", "D:relative.exe", String.raw`\rooted.exe`, "/project", "bad\n.exe"])(
		"fails an invalid environment override instead of using installed Studio: %j",
		async (file, { expect }) => {
			expect.assertions(1);

			const { seams } = setup({ registry: `"${WINDOWS}" %1` });

			await expect(
				seams.studioHost.findStudioExecutableAsync({
					env: { RBX_FORGE_STUDIO_PATH: file },
				}),
			).rejects.toMatchObject({ code: "studio_launch_failed" });
		},
	);

	it.for([
		new Error("unreadable"),
		new ForgeError("windows_helper_unavailable", "host unavailable"),
	])("preserves unexpected registry discovery failures: %j", async (error, { expect }) => {
		expect.assertions(1);

		const { seams } = setup({ registry: `"${WINDOWS}" %1` });
		seams.fileSystem.statSync = () => {
			throw error;
		};

		await expect(seams.studioHost.findStudioExecutableAsync({ env: {} })).rejects.toBe(error);
	});

	it("uses installed Studio when the environment override is empty", async ({ expect }) => {
		expect.assertions(1);

		const { seams } = setup({ registry: `"${WINDOWS}" %1` });

		await expect(
			seams.studioHost.findStudioExecutableAsync({ env: { RBX_FORGE_STUDIO_PATH: "" } }),
		).resolves.toEqual({ path: "/project/Studio.exe", source: "registry" });
	});

	it("does not use a platform launcher when Studio is absent", async ({ expect }) => {
		expect.assertions(1);

		const { seams } = setup();

		await expect(
			seams.studioHost.launchAsync({
				cwd: "/project",
				env: { RBX_FORGE_STUDIO_PATH: "" },
				place: "/project/game.rbxl",
			}),
		).rejects.toMatchObject({ code: "studio_launch_failed" });
	});

	it.for(["relative.exe", "/missing.exe", "/project", "/project/bad\r.exe"])(
		"rejects invalid explicit Studio %j",
		async (studioPath, { expect }) => {
			expect.assertions(1);

			const { seams } = setup();

			await expect(
				seams.studioHost.findStudioExecutableAsync({ env: {}, studioPath }),
			).rejects.toMatchObject({ code: "studio_launch_failed" });
		},
	);

	it("accepts Windows flag paths and trims a trailing converter carriage return", async ({
		expect,
	}) => {
		expect.assertions(2);

		const { seams } = setup({ output: "/project/Studio.exe\r" });

		await expect(
			seams.studioHost.findStudioExecutableAsync({ env: {}, studioPath: WINDOWS }),
		).resolves.toEqual({ path: "/project/Studio.exe", source: "flag" });

		const second = setup({ output: `${WINDOWS}\r\n` });

		await expect(second.seams.studioHost.toHostPathAsync("/project/game.rbxl")).resolves.toBe(
			WINDOWS,
		);
	});

	it.for(["relative", "", "bad\npath", "/relative-linux", "D:relative"])(
		"rejects bad Windows conversion output %j",
		async (output, { expect }) => {
			expect.assertions(1);

			const { seams } = setup({ output });

			await expect(
				seams.studioHost.toHostPathAsync("/project/game.rbxl"),
			).rejects.toMatchObject({ code: "studio_launch_failed" });
		},
	);

	it.for(["relative", "D:relative", "\\rooted", "D:\\temp\\agents\\bad\r.exe"])(
		"rejects bad Windows path input %j",
		async (input, { expect }) => {
			expect.assertions(1);

			const { seams } = setup();

			await expect(seams.studioHost.fromHostPathAsync(input)).rejects.toMatchObject({
				code: "studio_launch_failed",
			});
		},
	);

	it.for(["relative", "/missing", "D:\\temp\\agents\\file", "/project/Studio.exe\nextra"])(
		"rejects bad Linux conversion output %j",
		async (output, { expect }) => {
			expect.assertions(1);

			const { seams } = setup({ output });

			await expect(seams.studioHost.fromHostPathAsync(WINDOWS)).rejects.toMatchObject({
				code: "studio_launch_failed",
			});
		},
	);

	it.for(["relative", "/missing", "/project/game.rbxl\r"])(
		"rejects invalid Linux source %j",
		async (input, { expect }) => {
			expect.assertions(1);

			const { seams } = setup();

			await expect(seams.studioHost.toHostPathAsync(input)).rejects.toMatchObject({
				code: "studio_launch_failed",
			});
		},
	);

	it.for<ProcessOutcome>([
		{ ...OK, exitCode: 1, outputTail: [WINDOWS] },
		{ durationMs: 10, outputTail: [], type: "timed_out" },
		{ errorCode: "ENOENT", message: "missing", type: "spawn_failed" },
	])("rejects converter failure %j", async (result, { expect }) => {
		expect.assertions(1);

		const { seams } = setup({ result });

		await expect(seams.studioHost.toHostPathAsync("/project/game.rbxl")).rejects.toMatchObject({
			code: "studio_launch_failed",
			message: "wslpath could not convert /project/game.rbxl to an absolute path.",
		});
	});

	it("uses Windows hostname and FILETIME when attaching from Linux", async ({ expect }) => {
		expect.assertions(1);

		const { seams } = setup();
		seams.fileSystem.writeFileSync(
			"/project/game.rbxl.lock",
			"707\nRobloxStudioBeta\nwindows\n",
		);

		await expect(findPlaceStudioAsync(seams, "/project/game.rbxl")).resolves.toEqual({
			desktop: "user",
			os: "win32",
			pid: 707,
			startTime: PIN.startTime,
		});
	});

	it("refuses the Linux hostname in a Windows lock", async ({ expect }) => {
		expect.assertions(1);

		const { seams } = setup();
		seams.fileSystem.writeFileSync(
			"/project/game.rbxl.lock",
			"707\nRobloxStudioBeta\nforge-test\n",
		);

		await expect(findPlaceStudioAsync(seams, "/project/game.rbxl")).resolves.toBeUndefined();
	});

	it("closes the pinned Windows Studio", async ({ expect }) => {
		expect.assertions(1);

		const { seams } = setup();

		await expect(
			closeStudioAsync(
				seams,
				{ place: "/project/game.rbxl", process: PIN },
				{ env: {}, mode: "move", recoveryDirectory: "/project/recovery" },
			),
		).resolves.toMatchObject({ end: "exited", pid: 707, status: "stopped" });
	});

	it.for([null, "reused"])(
		"refuses missing or reused Windows PID %s",
		async (startTime, { expect }) => {
			expect.assertions(1);

			const { seams } = setup({ startTime });

			await expect(seams.studioHost.pinProcessAsync(707, PIN.startTime)).resolves.toBeNull();
		},
	);

	it("supports bounded liveness waits and pinned kill", async ({ expect }) => {
		expect.assertions(5);

		const { seams } = setup();
		const pin = await seams.studioHost.pinProcessAsync(707, PIN.startTime);
		assert(pin !== null);

		expect(await pin.waitForExitAsync(0)).toBe(false);
		expect(await pin.isBlockedAsync()).toBe(false);
		expect(await pin.killAsync()).toBe(true);
		expect(await pin.isAliveAsync()).toBe(false);
		expect(await pin.waitForExitAsync(100)).toBe(true);
	});

	it("keeps later feature capabilities explicitly outside the tracer", async ({ expect }) => {
		expect.assertions(6);

		const { seams } = setup();

		expect(await seams.studioHost.autoSaveDirectoriesAsync({})).toEqual([
			"/project/Studio.exe",
		]);
		expect(await seams.studioHost.pluginsFolderAsync({})).toBe("/project/Studio.exe");
		expect(await seams.studioHost.frontmostApplicationAsync()).toBeNull();
		expect(await seams.studioHost.platformAsync()).toBe("win32");
		expect(await seams.studioHost.tryLockFileAsync("/project/lock")).toBeNull();

		const pin = await seams.studioHost.pinProcessAsync(707);
		assert(pin !== null);

		await expect(pin.activateAppAsync()).rejects.toMatchObject({
			code: "windows_helper_unavailable",
		});
	});

	it("waits for a pinned Studio to finish exiting", async ({ expect }) => {
		expect.assertions(1);

		const { seams } = setup();
		const pin = await seams.studioHost.pinProcessAsync(707);
		assert(pin !== null);
		seams.clock.sleep = async () => {
			await pin.killAsync();
		};

		expect(await pin.waitForExitAsync(100)).toBe(true);
	});

	it("does not wait past an already elapsed exit deadline", async ({ expect }) => {
		expect.assertions(1);

		const { seams } = setup();
		const pin = await seams.studioHost.pinProcessAsync(707);
		assert(pin !== null);
		seams.clock.sleep = async () => {
			await pin.killAsync();
		};

		expect(await pin.waitForExitAsync(0)).toBe(false);
	});

	it("converts every direct-launch path and sends only named environment overrides", async ({
		expect,
	}) => {
		expect.assertions(2);

		const { conversions, requests, seams } = setup();
		await seams.studioHost.launchAsync({
			cwd: "/project",
			env: { HOME: "/linux", PATH: "/linux/bin", TMP: "/linux/tmp" },
			place: "/project/game.rbxl",
			runScript: "/project/script.lua",
			studioPath: "/project/Studio.exe",
		});

		expect(conversions).toEqual([
			{
				args: ["-w", "/project/Studio.exe"],
				cwd: "/",
				env: { PATH: "/fixture-bin" },
				file: "wslpath",
				timeoutMs: 10000,
			},
			{
				args: ["-w", "/project/game.rbxl"],
				cwd: "/",
				env: { PATH: "/fixture-bin" },
				file: "wslpath",
				timeoutMs: 10000,
			},
			{
				args: ["-w", "/project"],
				cwd: "/",
				env: { PATH: "/fixture-bin" },
				file: "wslpath",
				timeoutMs: 10000,
			},
			{
				args: ["-w", "/project/script.lua"],
				cwd: "/",
				env: { PATH: "/fixture-bin" },
				file: "wslpath",
				timeoutMs: 10000,
			},
		]);
		expect(requests).toEqual([
			{
				args: [
					"--task",
					"RunScript",
					"--localPlaceFile",
					WINDOWS,
					"--runScriptFile",
					WINDOWS,
				],
				cwd: WINDOWS,
				env: {},
				hiddenWindows: false,
				op: "launch",
				program: WINDOWS,
			},
		]);
	});

	it("converts a Windows path back to a Linux file", async ({ expect }) => {
		expect.assertions(2);

		const { conversions, seams } = setup();

		expect(await seams.studioHost.fromHostPathAsync(WINDOWS)).toBe("/project/Studio.exe");
		expect(conversions).toEqual([
			{
				args: ["-u", WINDOWS],
				cwd: "/",
				env: { PATH: "/fixture-bin" },
				file: "wslpath",
				timeoutMs: 10000,
			},
		]);
	});

	it("rejects a relative executable even when it names a file", async ({ expect }) => {
		expect.assertions(1);

		const { seams } = setup();
		seams.fileSystem.mkdirSync(".", { recursive: true });
		seams.fileSystem.writeFileSync("relative.exe", "fixture");

		await expect(
			seams.studioHost.findStudioExecutableAsync({ env: {}, studioPath: "relative.exe" }),
		).rejects.toMatchObject({
			code: "studio_launch_failed",
			message: "Studio executable is not an absolute file: relative.exe",
		});
	});

	it("rejects an existing executable containing a carriage return", async ({ expect }) => {
		expect.assertions(1);

		const { seams } = setup();
		seams.fileSystem.writeFileSync("/project/Studio\r.exe", "fixture");

		await expect(
			seams.studioHost.findStudioExecutableAsync({
				env: {},
				studioPath: "/project/Studio\r.exe",
			}),
		).rejects.toMatchObject({
			code: "studio_launch_failed",
			message: "Studio executable is not an absolute file: /project/Studio\r.exe",
		});
	});

	it("uses the Studio flag before the environment and ignores empty registry commands", async ({
		expect,
	}) => {
		expect.assertions(2);

		const { seams } = setup({ registry: "invalid command" });

		await expect(
			seams.studioHost.findStudioExecutableAsync({
				env: { RBX_FORGE_STUDIO_PATH: "/missing" },
				studioPath: "/project/Studio.exe",
			}),
		).resolves.toEqual({ path: "/project/Studio.exe", source: "flag" });
		await expect(
			seams.studioHost.findStudioExecutableAsync({ env: {} }),
		).resolves.toBeUndefined();
	});

	it("explains invalid paths, missing mounts and missing Studio", async ({ expect }) => {
		expect.assertions(6);

		const { seams } = setup();

		await expect(seams.studioHost.toHostPathAsync("relative")).rejects.toThrow(
			"Expected an absolute Linux path: relative",
		);
		await expect(seams.studioHost.fromHostPathAsync("relative")).rejects.toThrow(
			"Expected an absolute Windows path: relative",
		);
		await expect(seams.studioHost.toHostPathAsync("/missing")).rejects.toThrow(
			"The Linux path is unavailable: /missing",
		);
		await expect(
			seams.studioHost.launchAsync({ cwd: "/project", env: {}, place: "/project/game.rbxl" }),
		).rejects.toThrow("Windows Studio was not found. Set --studio-path.");

		const invalid = setup({ output: "relative" });

		await expect(
			invalid.seams.studioHost.toHostPathAsync("/project/game.rbxl"),
		).rejects.toThrow("wslpath could not convert /project/game.rbxl to an absolute path.");

		const missing = setup({ output: "/missing" });

		await expect(missing.seams.studioHost.fromHostPathAsync(WINDOWS)).rejects.toThrow(
			"The converted Windows path is unavailable in WSL: /missing",
		);
	});

	it("explains unsupported operations", async ({ expect }) => {
		expect.assertions(1);

		const { seams } = setup();

		const pin = await seams.studioHost.pinProcessAsync(707);
		assert(pin !== null);

		await expect(pin.activateAppAsync()).rejects.toThrow(
			"This Studio operation is not supported by the Windows helper tracer.",
		);
	});

	it("reports an unusable launch identity as unknown without launching again", async ({
		expect,
	}) => {
		expect.assertions(1);

		const { seams } = setup({ launchReply: { pid: 707 } });

		await expect(
			seams.studioHost.launchAsync({
				cwd: "/project",
				env: {},
				place: "/project/game.rbxl",
				studioPath: "/project/Studio.exe",
			}),
		).rejects.toMatchObject({
			code: "studio_launch_unknown",
			message:
				"The Windows helper returned no usable Studio launch identity. Check Studio before trying again.",
		});
	});

	it("rejects a missing Windows PID without a requested start time", async ({ expect }) => {
		expect.assertions(1);

		const { seams } = setup({ startTime: null });

		await expect(seams.studioHost.pinProcessAsync(707)).resolves.toBeNull();
	});

	it("returns the environment source and treats an empty override as unset", async ({
		expect,
	}) => {
		expect.assertions(2);

		const { seams } = setup();

		await expect(
			seams.studioHost.findStudioExecutableAsync({
				env: { RBX_FORGE_STUDIO_PATH: "/project/Studio.exe" },
			}),
		).resolves.toEqual({ path: "/project/Studio.exe", source: "environment" });
		await expect(
			seams.studioHost.launchAsync({
				cwd: "/project",
				env: { RBX_FORGE_STUDIO_PATH: "" },
				place: "/project/game.rbxl",
			}),
		).rejects.toThrow("Windows Studio was not found. Set --studio-path.");
	});

	it.for([`${WINDOWS}\nextra`, `${WINDOWS}\rextra`])(
		"rejects otherwise absolute conversion output containing a line break",
		async (output, { expect }) => {
			expect.assertions(1);

			const { seams } = setup({ output });

			await expect(seams.studioHost.toHostPathAsync("/project/game.rbxl")).rejects.toThrow(
				"wslpath could not convert /project/game.rbxl to an absolute path.",
			);
		},
	);

	it("rejects multiple converter output lines", async ({ expect }) => {
		expect.assertions(1);

		const { seams } = setup({ result: { ...OK, outputTail: [WINDOWS, "extra"] } });

		await expect(seams.studioHost.toHostPathAsync("/project/game.rbxl")).rejects.toMatchObject({
			code: "studio_launch_failed",
		});
	});
});
