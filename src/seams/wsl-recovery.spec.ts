import { type } from "arktype";
import path from "node:path";
import { assert, describe, it } from "vitest";

import { createFakeSpawner } from "../../test/helpers/fake-process.ts";
import { createMemoryFileSystem, createTestSeams } from "../../test/helpers/seams.ts";
import { ForgeError } from "../errors.ts";
import { createHelperClient } from "../native/helper-client.ts";
import { closeStudioAsync } from "../studio/close-studio.ts";
import { watchHiddenLightingAsync } from "../studio/lighting-dialog.ts";
import { saveStudioAsync } from "../studio/save-studio.ts";
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
const requestShape = type({ "id": "string", "lock?": "string", "op": "string", "pin?": "string" });

interface RecoveryOptions {
	badPin?: boolean;
	dead?: boolean;
	desktop?: unknown;
	hang?: boolean;
	host?: string;
	lateExit?: boolean;
	lockFailed?: boolean;
	refuseClose?: boolean;
	responseDelayMs?: number;
	retryLoss?: boolean;
	reused?: boolean;
	saved?: boolean;
	transientAttempts?: number;
	visibility?: string;
	wrongPin?: boolean;
	wrongStart?: boolean;
}

function helperResults(
	options: RecoveryOptions,
	isReplacement: boolean,
	isAlive: boolean,
	generation: number,
): Record<string, unknown> {
	const startTime = isReplacement && options.reused === true ? "999" : START;
	return {
		desktop: options.desktop ?? "user",
		dismissDialog: false,
		executablePath: String.raw`D:\temp\agents\RobloxStudioBeta.exe`,
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
						pid: isReplacement && options.wrongPin === true ? 708 : 707,
						pin: String(generation),
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
	let didDrop = false;
	let isAlive = true;
	let aliveQueries = 0;
	const states: Array<StudioControl> = [];
	const spawner = createFakeSpawner((child) => {
		child.stdin.setEncoding("utf8");
		child.stdin.on("data", handleRequest);
		// eslint-disable-next-line sonar/cognitive-complexity -- The fake helper models transport and operation fault points.
		function handleRequest(line: string): void {
			const request = requestShape.assert(JSON.parse(line));
			const isReplacement = didDrop;
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
				assert(request.pin === String(spawner.children.length), "stale Windows pin");
			}

			if (request.lock !== undefined) {
				assert(request.lock === String(spawner.children.length), "stale Windows lock");
			}

			const result = helperResults(options, isReplacement, isAlive, spawner.children.length);
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
			processRunner: async () => {
				return {
					durationMs: 1,
					exitCode: 0,
					outputTail: [String.raw`D:\temp\agents\312.lock`],
					signal: null,
					type: "exited",
				};
			},
		},
		() => {
			return createHelperClient(
				{ ...seams, childProcess: spawner.runner, clock },
				() => ({ args: [], file: "/helper.exe" }),
				"x64",
			);
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
		seams: { ...seams, clock, studioHost: host },
		signals,
		spawner,
		states,
		unsubscribe,
	};
}

async function observedAsync<T>(work: Promise<T>) {
	return work
		.then((value) => ({ value }))
		.catch((err: unknown) => {
			assert(err instanceof ForgeError);
			return { error: { code: err.code, details: err.details } };
		});
}

describe("windows helper recovery", () => {
	it("proves a lost hide using fresh visibility without hiding twice", async ({ expect }) => {
		expect.assertions(3);

		const run = world("setWindowVisibility");
		const pin = await run.seams.studioHost.pinProcessAsync(707, START);
		assert(pin !== null);

		await expect(pin.setWindowVisibilityAsync("hidden")).resolves.toBe(true);
		expect(run.effects.get("setWindowVisibility")).toBe(1);
		expect(run.states).toEqual(["ready", "recovering", "ready"]);
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
		[false, { error: { code: "process_failed" } }],
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
		[false, { error: { code: "save_failed", details: { reason: "unknown" } } }],
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

	it("stops recovery when the replacement reports another Windows host", async ({ expect }) => {
		expect.assertions(3);

		const run = world("setWindowVisibility", { host: "OTHER" });
		const pin = await run.seams.studioHost.pinProcessAsync(707, START);
		assert(pin !== null);

		await expect(pin.setWindowVisibilityAsync("hidden")).rejects.toThrow();
		await expect(pin.isAliveAsync()).rejects.toThrow("host changed");
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

	it.for([{ lockFailed: true }, { wrongPin: true }, { wrongStart: true }])(
		"refuses control when lock or pin restoration fails: %o",
		async (options, { expect }) => {
			expect.assertions(2);

			const run = world("setWindowVisibility", options);
			await run.seams.studioHost.tryLockFileAsync("/project/lock");
			const pin = await run.seams.studioHost.pinProcessAsync(707, START);
			assert(pin !== null);

			await expect(pin.setWindowVisibilityAsync("hidden")).rejects.toThrow();
			expect(run.states).toEqual(["ready", "recovering", "unavailable"]);
		},
	);

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

		await expect(run.seams.studioHost.pinProcessAsync(707, START)).rejects.toThrow();
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
});
