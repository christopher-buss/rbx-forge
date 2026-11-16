import { fromPartial } from "@total-typescript/shoehorn";

import { type } from "arktype";
import path from "node:path";
import { assert, describe, it } from "vitest";

import { createMemoryTransport } from "../../test/helpers/fake-ipc.ts";
import { createFakeSpawner } from "../../test/helpers/fake-process.ts";
import { makeStatus } from "../../test/helpers/fake-session.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
} from "../../test/helpers/seams.ts";
import { runDownAsync } from "../commands/down.ts";
import { ForgeError } from "../errors.ts";
import { createHelperClient } from "../native/helper-client.ts";
import { createStatusStore } from "../session/status.ts";
import { createStudioMover } from "../session/studio-move.ts";
import { closeStudioAsync } from "../studio/close-studio.ts";
import { keepStudioHiddenAsync } from "../studio/keep-hidden.ts";
import { watchHiddenLightingAsync } from "../studio/lighting-dialog.ts";
import { saveStudioAsync } from "../studio/save-studio.ts";
import { forgeFiles, sessionFiles } from "../supervisor/session-files.ts";
import { nodeClock } from "./clock.ts";
import type { StudioControl } from "./studio-host.ts";
import { createWslStudioHost } from "./wsl-studio-host.ts";

const PROJECT = path.resolve("D:/temp/agents/312-project");
const START = "134116992000000000";
const PLACE = path.join(PROJECT, "game.rbxl");
const PROCESS: import("../studio/launcher.ts").StudioProcess = {
	desktop: "user",
	os: "win32",
	pid: 707,
	startTime: START,
};
const requestShape = type({
	"id": "string",
	"deadlineMs": "number.integer >= 0",
	"lock?": "string",
	"op": "string",
	"path?": "string",
	"pid?": "number",
	"pin?": "string",
	"timeoutMs?": "number.integer >= 0",
	"visibility?": "string",
});

interface RecoveryOptions {
	badPin?: boolean;
	claimReleasedLock?: boolean;
	consumeSaveBudget?: boolean;
	dead?: boolean;
	delayFailureMs?: number;
	desktop?: unknown;
	hang?: boolean;
	holdSaveReply?: boolean;
	host?: string;
	lateExit?: boolean;
	lockFailed?: boolean;
	minimumSaveMs?: number;
	refuseClose?: boolean;
	responseDelayMs?: number;
	retryLoss?: boolean;
	reused?: boolean;
	saved?: boolean;
	transientAttempts?: number;
	visibility?: string;
	withoutEvents?: boolean;
	wrongPin?: boolean;
	wrongStart?: boolean;
}

function helperResults(
	options: RecoveryOptions,
	{
		generation,
		isAlive,
		isReplacement,
		pid,
	}: { generation: number; isAlive: boolean; isReplacement: boolean; pid: number },
): Record<string, unknown> {
	const startTime = isReplacement && options.reused === true ? "999" : START;
	return {
		desktop: options.desktop ?? "user",
		dismissDialog: false,
		executablePath: `D:\\temp\\agents\\${pid}\\RobloxStudioBeta.exe`,
		handshake: {
			helperArch: "x64",
			hostname: isReplacement ? (options.host ?? "WINDOWS") : "WINDOWS",
			protocol: 1,
			windowsArch: "x64",
		},
		isAlive,
		isBlocked: false,
		pin:
			options.badPin === true
				? {}
				: {
						pid: isReplacement && options.wrongPin === true ? 709 : pid,
						pin: `${generation}:${pid}`,
						startTime: isReplacement && options.wrongStart === true ? "999" : START,
					},
		processStartTime: isAlive ? startTime : null,
		releaseLock: true,
		requestClose: true,
		requestSave: "requested",
		saveMenuEnabled: true,
		tryLockFile: isReplacement && options.lockFailed === true ? null : String(generation),
		windowVisibility: options.visibility ?? "hidden",
	};
}

function world(drop: string, options: RecoveryOptions = {}) {
	const memory = createMemoryFileSystem();
	const seams = createTestSeams({ fileSystem: memory.fileSystem });
	seams.fileSystem.mkdirSync(PROJECT, { recursive: true });
	seams.fileSystem.writeFileSync(PLACE, "original");
	seams.fileSystem.writeFileSync(`${PLACE}.lock`, "707\nRobloxStudioBeta\nWINDOWS\n");
	const before = seams.fileSystem.statSync(PLACE).mtimeMs;
	let elapsed = 0;
	const signals: Array<AbortSignal> = [];
	const clock = {
		now: () => Date.UTC(2026, 10, 16) + elapsed,
		sleep: async (ms: number, signal?: AbortSignal) => {
			if (signal === undefined) {
				elapsed += ms;
				return;
			}

			signals.push(signal);
			return nodeClock.sleep(ms, signal);
		},
	};
	const effects = new Map<string, number>();
	const requests: Array<string> = [];
	let didDrop = false;
	let visibility = options.visibility ?? "hidden";
	let isHiding = false;
	let isAlive = true;
	let aliveQueries = 0;
	let didRelease = false;
	const states: Array<StudioControl> = [];
	const spawner = createFakeSpawner((child) => {
		const pins = new Map<string, number>();
		const heldLocks = new Set<string>();
		child.stdin.setEncoding("utf8");
		child.stdin.on("data", handleRequest);
		// eslint-disable-next-line sonar/cognitive-complexity -- The fake helper models transport and operation fault points.
		function handleRequest(line: string): void {
			const request = requestShape.assert(JSON.parse(line));
			requests.push(request.op);
			const isReplacement = spawner.children.length > 1;
			switch (request.op) {
				case "setWindowVisibility": {
					visibility = request.visibility === "hidden" ? "hidden" : "user";

					break;
				}
				case "startWindowHiding": {
					isHiding = true;

					break;
				}
				case "stopWindowHiding": {
					isHiding = false;

					break;
				}
				// No default
			}

			if (request.op === drop) {
				effects.set(drop, (effects.get(drop) ?? 0) + 1);
				if (options.dead === true) {
					isAlive = false;
				}

				if (options.saved === true) {
					seams.fileSystem.writeFileSync(PLACE, "saved");
					memory.setModifiedTime(PLACE, before + 1000);
				}

				if (!didDrop) {
					didDrop = true;
					if (options.holdSaveReply === true) {
						return;
					}

					child.stdout.end();
					return;
				}
			}

			if (isReplacement && options.hang === true) {
				return;
			}

			if (
				isReplacement &&
				(options.retryLoss === true ||
					spawner.children.length <= (options.transientAttempts ?? 0) + 1)
			) {
				child.stdout.end();
				return;
			}

			if (didDrop && options.lateExit === true && request.op === "isAlive") {
				aliveQueries += 1;
				isAlive = aliveQueries < 2;
			}

			if (options.refuseClose === true && request.op === "requestClose") {
				child.stdout.write(
					`${JSON.stringify({ id: request.id, error: { code: "refused", message: "close refused" } })}\n`,
				);
				return;
			}

			if (request.pin !== undefined) {
				assert(pins.has(request.pin), "stale Windows pin");
			}

			if (request.lock !== undefined) {
				assert(heldLocks.has(request.lock), "stale Windows lock");
				heldLocks.delete(request.lock);
				didRelease = true;
			}

			const pid = request.pid ?? pins.get(request.pin ?? "") ?? 707;
			const result = helperResults(options, {
				generation: spawner.children.length,
				isAlive,
				isReplacement,
				pid,
			});
			if (request.op === "requestSave" && options.minimumSaveMs !== undefined) {
				assert(request.timeoutMs !== undefined);
				result["requestSave"] =
					request.timeoutMs < options.minimumSaveMs ? "timeout" : "requested";
				if (result["requestSave"] === "requested") {
					seams.fileSystem.writeFileSync(PLACE, "saved");
					memory.setModifiedTime(PLACE, before + 1000);
				}
			}

			if (request.op === "requestSave" && options.consumeSaveBudget === true) {
				assert(request.timeoutMs !== undefined);
				elapsed += request.timeoutMs;
				seams.fileSystem.writeFileSync(PLACE, "saved");
				memory.setModifiedTime(PLACE, before + 1000);
			}

			result["windowVisibility"] = options.visibility ?? visibility;
			result["windowHiding"] = isHiding;
			result["startWindowHiding"] = true;
			result["stopWindowHiding"] = true;
			if (request.op === "pin") {
				pins.set(`${spawner.children.length}:${pid}`, pid);
			}

			if (request.op === "tryLockFile" && result["tryLockFile"] !== null) {
				result["tryLockFile"] = `${spawner.children.length}:${request.path}`;
				heldLocks.add(String(result["tryLockFile"]));
				if (isReplacement && didRelease && options.claimReleasedLock === true) {
					result["tryLockFile"] = null;
				}
			}

			function reply() {
				child.stdout.write(
					`${JSON.stringify({ id: request.id, result: result[request.op] })}\n`,
				);
			}

			if (options.responseDelayMs === undefined) {
				reply();
			} else {
				setTimeout(reply, options.responseDelayMs);
			}
		}
	});
	const host = createWslStudioHost(
		{
			...seams,
			clock,
			cwd: PROJECT,
			environment: {},
			processRunner: async (spec) => {
				const input = spec.args[1];
				assert(input !== undefined);
				return {
					durationMs: 1,
					exitCode: 0,
					outputTail: [`D:\\temp\\agents\\${path.posix.basename(input)}`],
					signal: null,
					type: "exited",
				};
			},
		},
		() => {
			const client = createHelperClient(
				{ ...seams, childProcess: spawner.runner, clock },
				() => ({ args: [], file: "/helper.exe" }),
				"x64",
			);
			async function requestAsync(
				...args: Parameters<typeof client.requestAsync>
			): Promise<unknown> {
				try {
					return await client.requestAsync(...args);
				} catch (err) {
					await nodeClock.sleep(options.delayFailureMs ?? 0);
					throw err;
				}
			}

			const { onFailure, ...rest } = client;
			return {
				...rest,
				...(onFailure === undefined || options.withoutEvents === true ? {} : { onFailure }),
				requestAsync,
			};
		},
	);
	const unsubscribe = host.onControl?.((state) => {
		states.push(state);
	});
	return {
		advance: (ms: number) => {
			elapsed += ms;
		},
		effects,
		exitStudio: () => {
			isAlive = false;
		},
		requests,
		seams: { ...seams, clock, studioHost: host },
		signals,
		spawner,
		states,
		unsubscribe,
	};
}

function retainedSession(run: ReturnType<typeof world>, side = "wsl:forge-test") {
	const forge = forgeFiles(PROJECT);
	const files = sessionFiles(forge, "retained");
	const status = makeStatus();
	status.services.studio = {
		...PROCESS,
		control: "ready",
		owner: null,
		place: PLACE,
		status: "open",
	};
	run.seams.fileSystem.mkdirSync(files.directory, { recursive: true });
	run.seams.fileSystem.writeFileSync(forge.current, "retained\n");
	run.seams.fileSystem.writeFileSync(
		files.identity,
		JSON.stringify({
			endpoint: "retained",
			pid: 500,
			processStartTime: "500",
			sessionId: "retained",
			side,
			startedAt: "2026-01-01T00:00:00.000Z",
			version: "9.9.9",
		}),
	);
	run.seams.fileSystem.writeFileSync(files.token, "token");
	run.seams.studioHost.onControl?.((control) => {
		status.services.studio.control = control;
		run.seams.fileSystem.writeFileSync(files.state, JSON.stringify(status));
	});
	const native = createFakeNative();
	const context = createCommandContext({
		cwd: PROJECT,
		seams: {
			...run.seams,
			host: { ...run.seams.host, platform: "linux", wslDistro: "forge-test" },
			ipc: createMemoryTransport(),
			native: () => native.addon,
		},
	});
	return { context, files };
}

async function observedAsync<T>(work: Promise<T>) {
	return work
		.then((value) => ({ value }))
		.catch((err: unknown) => {
			assert(err instanceof ForgeError);
			return {
				error: {
					cause: err.cause,
					code: err.code,
					details: err.details,
					message: err.message,
				},
			};
		});
}

describe("windows helper recovery", () => {
	it("does not let a queued short read retire an in-flight save", async ({ expect }) => {
		expect.assertions(6);

		const run = world("unused", { responseDelayMs: 40 });
		const pin = await run.seams.studioHost.pinProcessAsync(707, START);
		assert(pin !== null);
		const saving = pin.requestSaveAsync(200);

		await expect(pin.waitForExitAsync(5)).rejects.toMatchObject({
			code: "windows_helper_unavailable",
			message: "Windows helper is busy with another operation.",
		});

		const reading = pin.isAliveAsync();
		await nodeClock.sleep(5);

		expect(run.requests.filter((op) => op === "isAlive")).toHaveLength(0);
		await expect(saving).resolves.toBe("requested");
		expect(run.requests.filter((op) => op === "requestSave")).toHaveLength(1);
		await expect(reading).resolves.toBeTrue();
		expect(run.states).toEqual(["ready"]);
	});

	it("does not dispatch a queued read at its caller deadline", async ({ expect }) => {
		expect.assertions(3);

		const run = world("unused", { responseDelayMs: 40 });
		const pin = await run.seams.studioHost.pinProcessAsync(707, START);
		assert(pin !== null);
		const saving = pin.requestSaveAsync(5000);
		const waiting = pin.waitForExitAsync(1000);
		run.advance(1000);

		await expect(waiting).rejects.toMatchObject({
			code: "windows_helper_unavailable",
			message: "Windows helper is busy with another operation.",
		});
		await expect(saving).resolves.toBe("requested");
		expect(run.requests.filter((op) => op === "isAlive")).toHaveLength(0);
	});

	it("keeps a waiting request exclusive after the preceding operation finishes", async ({
		expect,
	}) => {
		expect.assertions(5);

		const run = world("unused", { responseDelayMs: 40 });
		const pin = await run.seams.studioHost.pinProcessAsync(707, START);
		assert(pin !== null);
		const saving = pin.requestSaveAsync(500);
		const reading = pin.isAliveAsync();

		await expect(saving).resolves.toBe("requested");
		await expect(pin.waitForExitAsync(5)).rejects.toMatchObject({
			code: "windows_helper_unavailable",
			message: "Windows helper is busy with another operation.",
		});
		await expect(reading).resolves.toBeTrue();
		expect(run.states).toEqual(["ready"]);
		expect(run.signals.every((signal) => signal.aborted)).toBeTrue();
	});

	it("allows a Windows save enough time to perform its menu action", async ({ expect }) => {
		expect.assertions(2);

		const run = world("unused", { minimumSaveMs: 50 });

		await expect(
			saveStudioAsync(
				{ ...run.seams, clock: nodeClock },
				{ place: PLACE, process: PROCESS },
				1000,
			),
		).resolves.toMatchObject({ bytes: 5, method: "menu" });
		expect(run.requests.filter((op) => op === "requestSave")).toHaveLength(1);
	});

	it("proves a save when its acknowledgement consumes the entire native action budget", async ({
		expect,
	}) => {
		expect.assertions(2);

		const run = world("unused", { consumeSaveBudget: true });

		await expect(
			saveStudioAsync(run.seams, { place: PLACE, process: PROCESS }, 1000),
		).resolves.toMatchObject({ bytes: 5, method: "menu" });
		expect(run.requests.filter((op) => op === "requestSave")).toHaveLength(1);
	});

	it("proves a lost hide using fresh visibility without hiding twice", async ({ expect }) => {
		expect.assertions(3);

		const run = world("setWindowVisibility");
		const pin = await run.seams.studioHost.pinProcessAsync(707, START);
		assert(pin !== null);

		await expect(pin.setWindowVisibilityAsync("hidden")).resolves.toBe(true);
		expect(run.effects.get("setWindowVisibility")).toBe(1);
		expect(run.states).toEqual(["ready", "recovering", "ready"]);
	});

	it("publishes a successful show after a lost reply so a later watcher respects it", async ({
		expect,
	}) => {
		expect.assertions(4);

		const run = world("setWindowVisibility");
		const files = sessionFiles(forgeFiles(PROJECT), "shown");
		run.seams.fileSystem.mkdirSync(files.directory, { recursive: true });
		const status = createStatusStore(
			{
				compiler: false,
				open: true,
				owner: null,
				pid: 1,
				port: 34872,
				sessionId: "shown",
				startedAt: "2026-01-01",
				syncback: false,
			},
			run.seams.clock.now,
			(state) => {
				run.seams.fileSystem.writeFileSync(files.state, JSON.stringify(state));
			},
		);
		status.studio("open", PLACE, { ...PROCESS, desktop: "hidden" }, "forge");
		const move = createStudioMover(
			fromPartial({
				context: createCommandContext({ cwd: PROJECT, seams: run.seams }),
				idle: { activity: () => {} },
				status,
			}),
			fromPartial({ signal: AbortSignal.timeout(60_000) }),
		);

		await expect(move({ desktop: "user" })).resolves.toMatchObject({
			from: "hidden",
			pid: 707,
			to: "user",
		});
		expect(status.snapshot().services.studio.desktop).toBe("user");

		await keepStudioHiddenAsync(
			run.seams,
			JSON.stringify({ isWindows: true, pid: 707, place: PLACE, startTime: START }),
			PROJECT,
		);
		const pin = await run.seams.studioHost.pinProcessAsync(707, START);
		assert(pin !== null);

		expect(await pin.windowVisibilityAsync()).toBe("user");
		expect(await pin.windowHidingAsync()).toBe(false);
	});

	it("bounds exit polling on a delayed helper channel", async ({ expect }) => {
		expect.assertions(1);

		const options = { responseDelayMs: 0 };
		const run = world("unused", options);
		const pin = await run.seams.studioHost.pinProcessAsync(707, START);
		assert(pin !== null);
		options.responseDelayMs = 500;

		await expect(pin.waitForExitAsync(100)).rejects.toThrow("deadline");
	});

	it("does not claim an unproved hide or repeat it", async ({ expect }) => {
		expect.assertions(2);

		const run = world("setWindowVisibility", { visibility: "user" });
		const pin = await run.seams.studioHost.pinProcessAsync(707, START);
		assert(pin !== null);

		await expect(pin.setWindowVisibilityAsync("hidden")).rejects.toThrow("EOF");
		expect(run.effects.get("setWindowVisibility")).toBe(1);
	});

	it.for([
		[
			false,
			{
				error: {
					cause: { message: "Windows helper EOF." },
					code: "process_failed",
					message: "The Studio close result is unknown; Studio was not killed.",
				},
			},
		],
		[true, { value: { end: "exited", forced: false, status: "stopped" } }],
	] as const)(
		"requires exit proof after losing a close reply: %o",
		async ([dead, expected], { expect }) => {
			expect.assertions(2);

			const run = world("requestClose", { dead });
			const outcome = closeStudioAsync(
				run.seams,
				{ place: PLACE, process: PROCESS },
				{ env: {}, mode: "delete", recoveryDirectory: path.join(PROJECT, "recovery") },
			);

			await expect(observedAsync(outcome)).resolves.toMatchObject(expected);
			expect(run.effects.get("requestClose")).toBe(1);
		},
	);

	it.for([
		[
			false,
			{
				error: {
					code: "save_failed",
					details: { reason: "unknown" },
					message:
						"The Studio save result is unknown. Check the place before saving again.",
				},
			},
		],
		[true, { value: { bytes: 5, method: "menu" } }],
	] as const)(
		"retains the original save proof after loss: %o",
		async ([saved, expected], { expect }) => {
			expect.assertions(2);

			const run = world("requestSave", { saved });
			const outcome = saveStudioAsync(run.seams, { place: PLACE, process: PROCESS }, 2000);

			await expect(observedAsync(outcome)).resolves.toMatchObject(expected);
			expect(run.effects.get("requestSave")).toBe(1);
		},
	);

	it("proves a completed save while its original helper reply consumes the deadline", async ({
		expect,
	}) => {
		expect.assertions(2);

		const run = world("requestSave", { holdSaveReply: true, saved: true });

		await expect(
			saveStudioAsync(
				{ ...run.seams, clock: nodeClock },
				{ place: PLACE, process: PROCESS },
				2000,
			),
		).resolves.toMatchObject({ bytes: 5, method: "menu" });
		expect(run.effects.get("requestSave")).toBe(1);
	});

	it("stops recovery when the replacement reports another Windows host", async ({ expect }) => {
		expect.assertions(4);

		const run = world("setWindowVisibility", { host: "OTHER" });
		const pin = await run.seams.studioHost.pinProcessAsync(707, START);
		assert(pin !== null);

		await expect(pin.setWindowVisibilityAsync("hidden")).rejects.toThrow("Windows helper EOF.");
		await expect(pin.isAliveAsync()).rejects.toThrow("host changed");
		expect(run.spawner.children).toHaveLength(2);
		expect(run.states).toEqual(["ready", "recovering", "unavailable"]);
	});

	it("exhausts bounded recovery and keeps control unavailable", async ({ expect }) => {
		expect.assertions(3);

		const run = world("setWindowVisibility", { retryLoss: true });
		const pin = await run.seams.studioHost.pinProcessAsync(707, START);
		assert(pin !== null);

		await expect(pin.setWindowVisibilityAsync("hidden")).rejects.toThrow();
		await expect(pin.isAliveAsync()).rejects.toThrow();
		expect(run.states).toEqual(["ready", "recovering", "unavailable"]);
	});

	it("rejects a reused PID after recovery without commanding its new process", async ({
		expect,
	}) => {
		expect.assertions(3);

		const run = world("setWindowVisibility", { reused: true });
		const pin = await run.seams.studioHost.pinProcessAsync(707, START);
		assert(pin !== null);

		await expect(pin.setWindowVisibilityAsync("hidden")).rejects.toThrow();
		await expect(pin.isAliveAsync()).resolves.toBe(false);
		await expect(pin.requestCloseAsync()).rejects.toThrow("exited");
	});

	it("shares initial identity and a single recovery between concurrent callers", async ({
		expect,
	}) => {
		expect.assertions(3);

		const run = world("windowVisibility");

		await expect(
			Promise.all([
				run.seams.studioHost.hostnameAsync(),
				run.seams.studioHost.hostnameAsync(),
			]),
		).resolves.toEqual(["WINDOWS", "WINDOWS"]);

		const pin = await run.seams.studioHost.pinProcessAsync(707, START);
		assert(pin !== null);

		await expect(
			Promise.all([pin.windowVisibilityAsync(), pin.isAliveAsync()]),
		).resolves.toEqual(["hidden", true]);
		expect(run.states).toEqual(["ready", "recovering", "ready"]);
	});

	it("retakes the Windows lock before restoring Studio control", async ({ expect }) => {
		expect.assertions(3);

		const run = world("setWindowVisibility");
		const lock = await run.seams.studioHost.tryLockFileAsync("/project/lock");
		assert(lock !== null);
		const pin = await run.seams.studioHost.pinProcessAsync(707, START);
		assert(pin !== null);

		await expect(pin.setWindowVisibilityAsync("hidden")).resolves.toBe(true);
		await expect(lock.releaseAsync()).resolves.toBeUndefined();
		expect(run.states).toEqual(["ready", "recovering", "ready"]);
	});

	it.for([
		{ diagnostic: "Windows singleton lock could not be retaken.", lockFailed: true },
		{ diagnostic: "Windows helper returned a different Studio identity.", wrongPin: true },
		{ diagnostic: "Windows helper returned a different Studio identity.", wrongStart: true },
	])("refuses control when lock or pin restoration fails: %o", async (options, { expect }) => {
		expect.assertions(4);

		const run = world("setWindowVisibility", options);
		await run.seams.studioHost.tryLockFileAsync("/project/lock");
		const pin = await run.seams.studioHost.pinProcessAsync(707, START);
		assert(pin !== null);

		await expect(pin.setWindowVisibilityAsync("hidden")).rejects.toThrow();
		await expect(run.seams.studioHost.hostnameAsync()).rejects.toThrow(options.diagnostic);
		expect(run.spawner.children).toHaveLength(2);
		expect(run.states).toEqual(["ready", "recovering", "unavailable"]);
	});

	it("stops on malformed operation results", async ({ expect }) => {
		expect.assertions(2);

		const run = world("unused", { desktop: 123 });
		const pin = await run.seams.studioHost.pinProcessAsync(707, START);
		assert(pin !== null);

		await expect(pin.desktopAsync()).rejects.toThrow();
		expect(run.states).toEqual(["ready", "unavailable"]);
	});

	it("stops on malformed pin identities", async ({ expect }) => {
		expect.assertions(2);

		const run = world("unused", { badPin: true });

		await expect(run.seams.studioHost.pinProcessAsync(707, START)).rejects.toThrow("pin must");
		expect(run.states).toEqual(["ready", "unavailable"]);
	});

	it("stops on malformed transport frames without recovery", async ({ expect }) => {
		expect.assertions(2);

		const run = world("unused");
		await run.seams.studioHost.hostnameAsync();
		run.spawner.children[0]!.stdout.emit("data", "not json\n");

		await expect(run.seams.studioHost.hostnameAsync()).rejects.toThrow();
		expect(run.states).toEqual(["ready", "unavailable"]);
	});

	it("does not recover a missing helper installation", async ({ expect }) => {
		expect.assertions(1);

		const seams = createTestSeams();
		const host = createWslStudioHost({ ...seams, cwd: PROJECT, environment: {} }, () => {
			throw new ForgeError("windows_helper_unavailable", "missing helper");
		});

		await expect(host.hostnameAsync()).rejects.toThrow("missing helper");
	});

	it("preserves a caller deadline while recovery continues for the session", async ({
		expect,
	}) => {
		expect.assertions(2);

		const run = world("dismissDialog");
		const pin = await run.seams.studioHost.pinProcessAsync(707, START);
		assert(pin !== null);

		await expect(pin.dismissDialogAsync("prompt", "button", "user", 1)).rejects.toThrow();
		await expect(pin.isAliveAsync()).resolves.toBe(true);
	});

	it("confirms a late verified exit after losing a close result", async ({ expect }) => {
		expect.assertions(1);

		const run = world("requestClose", { lateExit: true });

		await expect(
			closeStudioAsync(
				run.seams,
				{ place: PLACE, process: PROCESS },
				{ env: {}, mode: "delete", recoveryDirectory: path.join(PROJECT, "recovery") },
			),
		).resolves.toMatchObject({ forced: false, status: "stopped" });
	});

	it("does not escalate a helper close failure", async ({ expect }) => {
		expect.assertions(1);

		const run = world("unused", { refuseClose: true });

		await expect(
			closeStudioAsync(
				run.seams,
				{ place: PLACE, process: PROCESS },
				{ env: {}, mode: "delete", recoveryDirectory: path.join(PROJECT, "recovery") },
			),
		).rejects.toThrow("close refused");
	});

	it("limits repeated losses within the reset window", async ({ expect }) => {
		expect.assertions(4);

		const run = world("unused");
		const pin = await run.seams.studioHost.pinProcessAsync(707, START);
		assert(pin !== null);
		for (const index of [0, 1, 2]) {
			run.spawner.children[index]!.stdout.emit("end");

			await expect(pin.isAliveAsync()).resolves.toBe(true);
		}

		run.spawner.children[3]!.stdout.emit("end");

		await expect(pin.isAliveAsync()).rejects.toThrow("exhausted");
	});

	it("releases availability subscriptions", async ({ expect }) => {
		expect.assertions(1);

		const run = world("windowVisibility");
		run.unsubscribe!();
		const pin = await run.seams.studioHost.pinProcessAsync(707, START);
		assert(pin !== null);
		await pin.windowVisibilityAsync();

		expect(run.states).toEqual(["ready"]);
	});

	it("bounds a replacement that never completes its handshake", async ({ expect }) => {
		expect.assertions(2);

		const run = world("dismissDialog", { hang: true });
		const pin = await run.seams.studioHost.pinProcessAsync(707, START);
		assert(pin !== null);

		await expect(pin.dismissDialogAsync("prompt", "button", "user", 1)).rejects.toThrow();
		await expect(run.seams.studioHost.hostnameAsync()).rejects.toThrow("deadline");
	});

	it("recovers transport loss during the initial handshake", async ({ expect }) => {
		expect.assertions(2);

		const run = world("handshake");

		await expect(run.seams.studioHost.hostnameAsync()).resolves.toBe("WINDOWS");
		expect(run.states).toEqual(["ready", "recovering", "ready"]);
	});

	it("does not repeat an uncertain Lighting dialog dismissal", async ({ expect }) => {
		expect.assertions(1);

		const run = world("dismissDialog", { desktop: "hidden" });
		const abort = new AbortController();
		await watchHiddenLightingAsync(
			run.seams,
			{ place: PLACE, process: PROCESS },
			{ openingTimeoutMs: 2000, signal: abort.signal },
		);

		expect(run.effects.get("dismissDialog")).toBe(1);
	});

	it("retains request deadlines while restoring locks and pins", async ({ expect }) => {
		expect.assertions(2);

		const run = world("setWindowVisibility", { responseDelayMs: 20 });
		const lock = await run.seams.studioHost.tryLockFileAsync("/project/lock");
		assert(lock !== null);
		const pin = await run.seams.studioHost.pinProcessAsync(707, START);
		assert(pin !== null);

		await expect(pin.setWindowVisibilityAsync("hidden")).resolves.toBe(true);
		await expect(lock.releaseAsync()).resolves.toBeUndefined();
	});

	it("recovers idle helper loss before the next command arrives", async ({ expect }) => {
		expect.assertions(2);

		const run = world("unused");
		await run.seams.studioHost.hostnameAsync();
		run.spawner.children[0]!.stdout.emit("end");
		await nodeClock.sleep(10);

		expect(run.states).toEqual(["ready", "recovering", "ready"]);

		run.spawner.children[1]!.stdout.emit("end");
		await nodeClock.sleep(10);

		expect(run.states).toEqual(["ready", "recovering", "ready", "recovering", "ready"]);
	});

	it("confirms a lost close reply through the verified pin", async ({ expect }) => {
		expect.assertions(1);

		const run = world("requestClose", { dead: true });
		const pin = await run.seams.studioHost.pinProcessAsync(707, START);
		assert(pin !== null);

		await expect(pin.requestCloseAsync()).resolves.toBe(true);
	});

	it("cancels recovery deadlines after control is restored", async ({ expect }) => {
		expect.assertions(1);

		const run = world("windowVisibility");
		const pin = await run.seams.studioHost.pinProcessAsync(707, START);
		assert(pin !== null);
		await pin.windowVisibilityAsync();

		expect(run.signals.every((signal) => signal.aborted)).toBe(true);
	});

	it("respects a read deadline across multiple recovery attempts", async ({ expect }) => {
		expect.assertions(1);

		const run = world("saveMenuEnabled", { transientAttempts: 2 });
		const pin = await run.seams.studioHost.pinProcessAsync(707, START);
		assert(pin !== null);

		await expect(pin.saveMenuEnabledAsync(500)).rejects.toThrow();
	});

	it("retains an unavailable own-side session until fresh control proves its Studio gone", async ({
		expect,
	}) => {
		expect.assertions(6);

		const run = world("setWindowVisibility", { retryLoss: true });
		const session = retainedSession(run);
		const pin = await run.seams.studioHost.pinProcessAsync(707, START);
		assert(pin !== null);

		await expect(pin.setWindowVisibilityAsync("hidden")).rejects.toThrow();
		await expect(
			runDownAsync(session.context, { config: {}, flags: {} }),
		).rejects.toMatchObject({ code: "cleanup_in_progress" });
		expect(run.seams.fileSystem.existsSync(session.files.identity)).toBe(true);

		const fresh = world("unused");
		session.context.seams.studioHost = fresh.seams.studioHost;

		await expect(
			runDownAsync(session.context, { config: {}, flags: {} }),
		).rejects.toMatchObject({ code: "cleanup_in_progress" });

		fresh.exitStudio();

		await expect(
			runDownAsync(session.context, { config: {}, flags: {} }),
		).resolves.toMatchObject({ data: { removed: true, status: "stopped" } });
		expect(run.seams.fileSystem.existsSync(session.files.identity)).toBe(false);
	});

	it.for(["open", "off", "closed"] as const)(
		"retains stale ready after a supervisor crash with Studio %s until fresh control proves exit",
		async (studioStatus, { expect }) => {
			expect.assertions(4);

			const run = world("unused");
			const session = retainedSession(run);
			const status = makeStatus();
			status.services.studio = {
				...PROCESS,
				control: "ready",
				owner: null,
				place: PLACE,
				status: studioStatus,
			};
			run.seams.fileSystem.writeFileSync(session.files.state, JSON.stringify(status));

			await expect(
				runDownAsync(session.context, { config: {}, flags: {} }),
			).rejects.toHaveProperty("code", "cleanup_in_progress");
			expect(run.seams.fileSystem.existsSync(session.files.identity)).toBe(true);

			run.exitStudio();

			await expect(
				runDownAsync(session.context, { config: {}, flags: {} }),
			).resolves.toMatchObject({ data: { removed: true } });
			expect(run.seams.fileSystem.existsSync(session.files.identity)).toBe(false);
		},
	);

	it.for([
		{ isLaunchUnknown: true, owner: null, status: "off" },
		{ control: "ready", os: "win32", owner: null, status: "opening" },
		{ isLaunchUnknown: true, origin: "found", owner: null, status: "off" },
	] as const)(
		"retains a Windows launch without a usable identity: %j",
		async (studio, { expect }) => {
			expect.assertions(2);

			const run = world("unused");
			const session = retainedSession(run);
			const status = makeStatus();
			status.services.studio = studio;
			run.seams.fileSystem.writeFileSync(session.files.state, JSON.stringify(status));

			await expect(
				runDownAsync(session.context, { config: {}, flags: {} }),
			).rejects.toHaveProperty("code", "cleanup_in_progress");
			expect(run.seams.fileSystem.existsSync(session.files.identity)).toBe(true);
		},
	);

	it("refuses fresh-control cleanup of a retained foreign-side record", async ({ expect }) => {
		expect.assertions(2);

		const run = world("unused");
		const session = retainedSession(run, "windows");
		run.exitStudio();

		await expect(
			runDownAsync(session.context, { config: {}, flags: { force: true } }),
		).rejects.toMatchObject({ code: "identity_mismatch" });
		expect(run.seams.fileSystem.existsSync(session.files.identity)).toBe(true);
	});

	it("keeps two Windows identities distinct across recovery", async ({ expect }) => {
		expect.assertions(3);

		const run = world("setWindowVisibility");
		const first = await run.seams.studioHost.pinProcessAsync(707, START);
		const second = await run.seams.studioHost.pinProcessAsync(708, START);
		assert(first !== null && second !== null);

		await expect(first.setWindowVisibilityAsync("hidden")).resolves.toBe(true);
		await expect(first.executablePathAsync()).resolves.toBe(
			String.raw`D:\temp\agents\707\RobloxStudioBeta.exe`,
		);
		await expect(second.executablePathAsync()).resolves.toBe(
			String.raw`D:\temp\agents\708\RobloxStudioBeta.exe`,
		);
	});

	it("does not retake a lock released before later channel loss", async ({ expect }) => {
		expect.assertions(2);

		const run = world("unused", { claimReleasedLock: true });
		const lock = await run.seams.studioHost.tryLockFileAsync("/project/lock");
		assert(lock !== null);
		await lock.releaseAsync();
		run.spawner.children[0]!.stdout.emit("end");

		await expect(run.seams.studioHost.hostnameAsync()).resolves.toEqual("WINDOWS");
		expect(run.states).toEqual(["ready", "recovering", "ready"]);
	});

	it("keeps independent Windows locks distinct when one is released", async ({ expect }) => {
		expect.assertions(1);

		const run = world("unused");
		const first = await run.seams.studioHost.tryLockFileAsync("/project/one.lock");
		const second = await run.seams.studioHost.tryLockFileAsync("/project/two.lock");
		assert(first !== null && second !== null);
		await first.releaseAsync();
		run.spawner.children[0]!.stdout.emit("end");
		await run.seams.studioHost.hostnameAsync();

		await expect(second.releaseAsync()).resolves.toBeUndefined();
	});

	it("does not confirm another lost mutation merely because Studio exited", async ({
		expect,
	}) => {
		expect.assertions(1);

		const run = world("stopWindowHiding", { dead: true });
		const pin = await run.seams.studioHost.pinProcessAsync(707, START);
		assert(pin !== null);

		await expect(pin.stopWindowHidingAsync()).rejects.toThrow("EOF");
	});

	it("recovers transient replacement losses within the caller deadline", async ({ expect }) => {
		expect.assertions(1);

		const run = world("saveMenuEnabled", { transientAttempts: 2 });
		const pin = await run.seams.studioHost.pinProcessAsync(707, START);
		assert(pin !== null);

		await expect(pin.saveMenuEnabledAsync(2000)).resolves.toBe(true);
	});

	it.for([{ withoutEvents: true }, { delayFailureMs: 20 }])(
		"recovers exactly once when the lost result arrives after its notification: %o",
		async (options, { expect }) => {
			expect.assertions(2);

			const run = world("setWindowVisibility", options);
			const pin = await run.seams.studioHost.pinProcessAsync(707, START);
			assert(pin !== null);

			await expect(pin.setWindowVisibilityAsync("hidden")).resolves.toBe(true);
			expect(run.states).toEqual(["ready", "recovering", "ready"]);
		},
	);

	it("resets the exhausted attempt budget after a healthy minute", async ({ expect }) => {
		expect.assertions(1);

		const run = world("unused");
		await run.seams.studioHost.hostnameAsync();
		for (const index of [0, 1, 2]) {
			run.spawner.children[index]!.stdout.emit("end");
			await run.seams.studioHost.hostnameAsync();
		}

		run.advance(60_000);
		run.spawner.children[3]!.stdout.emit("end");

		await expect(run.seams.studioHost.hostnameAsync()).resolves.toBe("WINDOWS");
	});

	it("does not send a read when recovery consumes the entire caller deadline", async ({
		expect,
	}) => {
		expect.assertions(1);

		const run = world("saveMenuEnabled");
		const pin = await run.seams.studioHost.pinProcessAsync(707, START);
		assert(pin !== null);

		await expect(pin.saveMenuEnabledAsync(100)).rejects.toThrow("Windows helper EOF.");
	});

	it("keeps missing-helper failure terminal without another recovery cycle", async ({
		expect,
	}) => {
		expect.assertions(3);

		const seams = createTestSeams();
		const failure = new ForgeError("windows_helper_unavailable", "missing helper");
		const host = createWslStudioHost({ ...seams, cwd: PROJECT, environment: {} }, () => {
			throw failure;
		});
		const states: Array<StudioControl> = [];
		host.onControl!((state) => {
			states.push(state);
		});

		await expect(host.hostnameAsync()).rejects.toBe(failure);
		await expect(host.hostnameAsync()).rejects.toBe(failure);
		expect(states).toEqual(["ready", "unavailable"]);
	});

	it("preserves the full diagnostic and cause of an uncertain close", async ({ expect }) => {
		expect.assertions(1);

		const run = world("requestClose");

		await expect(
			closeStudioAsync(
				run.seams,
				{ place: PLACE, process: PROCESS },
				{ env: {}, mode: "delete", recoveryDirectory: path.join(PROJECT, "recovery") },
			),
		).rejects.toMatchObject({
			cause: { message: "Windows helper EOF." },
			code: "process_failed",
			message: "The Studio close result is unknown; Studio was not killed.",
		});
	});

	it("keeps a close uncertain when fresh exit proof also loses control", async ({ expect }) => {
		expect.assertions(2);

		const run = world("requestClose", { hang: true });

		await expect(
			closeStudioAsync(
				run.seams,
				{ place: PLACE, process: PROCESS },
				{ env: {}, mode: "delete", recoveryDirectory: path.join(PROJECT, "recovery") },
			),
		).rejects.toMatchObject({
			code: "process_failed",
			message: "The Studio close result is unknown; Studio was not killed.",
		});
		expect(run.effects.get("requestClose")).toBe(1);
	});

	it("reports the original proof missing for an uncertain save", async ({ expect }) => {
		expect.assertions(1);

		const run = world("requestSave");

		await expect(
			saveStudioAsync(run.seams, { place: PLACE, process: PROCESS }, 2000),
		).rejects.toMatchObject({
			code: "save_failed",
			details: { reason: "unknown" },
			message: "The Studio save result is unknown. Check the place before saving again.",
		});
	});

	it("explains why an old Windows identity cannot be commanded after PID reuse", async ({
		expect,
	}) => {
		expect.assertions(2);

		const run = world("setWindowVisibility", { reused: true });
		const pin = await run.seams.studioHost.pinProcessAsync(707, START);
		assert(pin !== null);

		await expect(pin.setWindowVisibilityAsync("hidden")).rejects.toThrow();
		await expect(pin.requestCloseAsync()).rejects.toMatchObject({
			code: "identity_mismatch",
			message: "The pinned Windows Studio has exited.",
		});
	});

	it("explains why a live Studio retains its record after fresh control", async ({ expect }) => {
		expect.assertions(2);

		const run = world("setWindowVisibility", { retryLoss: true });
		const session = retainedSession(run);
		const pin = await run.seams.studioHost.pinProcessAsync(707, START);
		assert(pin !== null);

		await expect(pin.setWindowVisibilityAsync("hidden")).rejects.toThrow();

		const fresh = world("unused");
		session.context.seams.studioHost = fresh.seams.studioHost;

		await expect(
			runDownAsync(session.context, { config: {}, flags: {} }),
		).rejects.toMatchObject({
			cause: { message: "The recorded Windows Studio still runs." },
			code: "cleanup_in_progress",
			message:
				"Windows Studio cleanup is unverified; the session identity record is retained.",
		});
	});
});
