import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { makeStatus } from "../../test/helpers/fake-session.ts";
import type { FakeNative, FakeProcess } from "../../test/helpers/native.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import type { MemoryFileSystem } from "../../test/helpers/seams.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
	TEST_HOSTNAME,
} from "../../test/helpers/seams.ts";
import { DEFAULT_CONFIG } from "../config/resolve.ts";
import { ForgeError } from "../errors.ts";
import type { Clock } from "../seams/clock.ts";
import { STUDIO_CLOSE_MS } from "../studio/close-studio.ts";
import { IDLE_STOP } from "./idle.ts";
import type {
	PartStops,
	StopPartsRequest,
	StopperParts,
	StopPlan,
	StudioOutcome,
} from "./part-stops.ts";
import {
	createPartStopper,
	planStops,
	sessionStudioTarget,
	STUDIO_CLOSED_SYNCBACK_MS,
	STUDIO_OPEN_WAIT_MS,
} from "./part-stops.ts";
import type { SessionEndReason } from "./run-session.ts";
import type {
	ServiceId,
	ServicePart,
	SessionStatus,
	SessionStudio,
	StatusStore,
} from "./status.ts";

const PLACE = path.join(PROJECT, "game.rbxl");
const LOCK = `${PLACE}.lock`;
const STUDIO = String.raw`C:\Roblox\Versions\version-1\RobloxStudioBeta.exe`;
const STUDIO_PID = 4242;
const ANY_TEXT: unknown = expect.any(String);
const DOWN: StopPartsRequest = { force: false, keepStudio: false, scope: "down" };
const STOP: StopPartsRequest = { force: false, keepStudio: false, scope: "stop" };

type Services = SessionStatus["services"];

/**
 * The parts' status of a session.
 *
 * @param parts - Each part's status and owner; `off` with no owner when
 *   absent.
 * @returns The services of a status.
 */
function servicesWith(
	parts: {
		compiler?: Partial<Services["compiler"]>;
		rojo?: Partial<Services["rojo"]>;
		studio?: Partial<SessionStudio>;
	} = {},
): Services {
	const { services } = makeStatus();
	return {
		...services,
		compiler: { ...services.compiler, ...parts.compiler },
		rojo: { ...services.rojo, status: "off", ...parts.rojo },
		studio: { ...services.studio, ...parts.studio },
	};
}

const READY: Partial<ServicePart> = { owner: null, status: "ready" };
const OPEN: Partial<SessionStudio> = { owner: null, place: PLACE, status: "open" };
const OWNED: Pick<ServicePart, "owner"> = { owner: "start" };

describe(planStops, () => {
	it.for<[string, Services, StopPartsRequest, StopPlan]>([
		[
			"every running part with no owner, Studio first, for down",
			servicesWith({ compiler: READY, rojo: READY, studio: OPEN }),
			DOWN,
			{ kept: [], stop: ["studio", "rojo", "compiler"] },
		],
		[
			"no part that does not run",
			servicesWith({
				compiler: { status: "failed" },
				rojo: { status: "off" },
				studio: { place: PLACE, status: "closed" },
			}),
			DOWN,
			{ kept: [], stop: [] },
		],
		[
			"starting parts and an opening Studio",
			servicesWith({
				compiler: { status: "starting" },
				rojo: { status: "starting" },
				studio: { status: "opening" },
			}),
			{ ...DOWN, scope: "restart" },
			{ kept: [], stop: ["studio", "rojo", "compiler"] },
		],
		[
			"owned parts to their owner",
			servicesWith({
				compiler: READY,
				rojo: { ...READY, ...OWNED },
				studio: { ...OPEN, ...OWNED },
			}),
			DOWN,
			{
				kept: [
					{ owner: "start", part: "studio" },
					{ owner: "start", part: "rojo" },
				],
				stop: ["compiler"],
			},
		],
		[
			"owned parts too with force",
			servicesWith({ compiler: { ...READY, ...OWNED }, studio: { ...OPEN, ...OWNED } }),
			{ ...DOWN, force: true },
			{ kept: [], stop: ["studio", "compiler"] },
		],
		[
			"Studio for restart, which takes no keepStudio",
			servicesWith({ studio: OPEN }),
			{ ...DOWN, keepStudio: true, scope: "restart" },
			{ kept: [], stop: ["studio"] },
		],
		[
			"Studio to keepStudio",
			servicesWith({ compiler: READY, rojo: READY, studio: OPEN }),
			{ ...DOWN, keepStudio: true },
			{ kept: [], stop: ["rojo", "compiler"] },
		],
		[
			"Studio and its Rojo, not the compiler, for stop",
			servicesWith({ compiler: READY, rojo: READY, studio: OPEN }),
			{ ...STOP, keepStudio: true },
			{ kept: [], stop: ["studio", "rojo"] },
		],
		[
			"the Studio of the place stop names",
			servicesWith({ rojo: READY, studio: OPEN }),
			{ ...STOP, place: PLACE },
			{ kept: [], stop: ["studio", "rojo"] },
		],
		[
			"nothing for the place of another Studio",
			servicesWith({ rojo: READY, studio: OPEN }),
			{ ...STOP, place: path.join(PROJECT, "other.rbxl") },
			{ kept: [], stop: [] },
		],
		[
			"Rojo with no Studio to stop",
			servicesWith({ compiler: READY, rojo: READY }),
			STOP,
			{ kept: [], stop: [] },
		],
		[
			"Rojo that has an owner, while its Studio stops",
			servicesWith({ rojo: { ...READY, ...OWNED }, studio: OPEN }),
			STOP,
			{ kept: [{ owner: "start", part: "rojo" }], stop: ["studio"] },
		],
		[
			"Rojo with a Studio that has an owner",
			servicesWith({ rojo: READY, studio: { ...OPEN, ...OWNED } }),
			STOP,
			{ kept: [{ owner: "start", part: "studio" }], stop: [] },
		],
	])("should stop %s", ([, services, request, plan]) => {
		expect.assertions(1);

		expect(planStops(services, request)).toStrictEqual(plan);
	});
});

describe(sessionStudioTarget, () => {
	it("should target the Studio forge started, open or opening", () => {
		expect.assertions(2);

		expect(
			sessionStudioTarget({
				owner: null,
				pid: 7,
				place: PLACE,
				startTime: "70",
				status: "open",
			}),
		).toStrictEqual({ place: PLACE, process: { pid: 7, startTime: "70" } });
		expect(sessionStudioTarget({ owner: null, place: PLACE, status: "opening" })).toStrictEqual(
			{ place: PLACE },
		);
	});

	it("should target nothing for a closed or unknown place", () => {
		expect.assertions(3);

		expect(
			sessionStudioTarget({ owner: null, place: PLACE, status: "closed" }),
		).toBeUndefined();
		expect(sessionStudioTarget({ owner: null, place: PLACE, status: "off" })).toBeUndefined();
		expect(sessionStudioTarget({ owner: null, status: "opening" })).toBeUndefined();
	});

	it("should need both the PID and the start time to pin", () => {
		expect.assertions(1);

		expect(
			sessionStudioTarget({ owner: null, pid: 7, place: PLACE, status: "open" }),
		).toStrictEqual({ place: PLACE });
	});
});

/** A session for the stopper: its status, parts, Studio, and clock. */
interface StopWorld {
	clock: Clock;
	ended: Array<SessionEndReason>;
	flushed: () => number;
	memory: MemoryFileSystem;
	native: FakeNative;
	/** Milliseconds the clock moved. */
	now: () => number;
	/** Runs on each sleep, once the time moved. */
	onSleep: Array<(now: number) => void>;
	phase: ReturnType<typeof vi.fn<StatusStore["phase"]>>;
	/** What `studio` recorded. */
	recorded: ReturnType<typeof vi.fn<StatusStore["studio"]>>;
	running: Set<ServiceId>;
	/** What `snapshot` answers; change it to move the session on. */
	services: Services;
	stopped: Array<ServiceId>;
	stopper: StopperParts;
}

function makeWorld(services: Services, running: Array<ServiceId> = []): StopWorld {
	let now = 0;
	let flushes = 0;
	const onSleep: StopWorld["onSleep"] = [];
	const world: StopWorld = {
		clock: {
			now: () => now,
			sleep: async (ms) => {
				now += ms;
				for (const hook of onSleep) {
					hook(now);
				}
			},
		},
		ended: [],
		flushed: () => flushes,
		memory: createMemoryFileSystem(),
		native: createFakeNative({}),
		now: () => now,
		onSleep,
		phase: vi.fn<StatusStore["phase"]>(),
		recorded: vi.fn<StatusStore["studio"]>(),
		running: new Set(running),
		services,
		stopped: [],
		stopper: {
			flushSyncbackAsync: async () => {
				flushes += 1;
			},
			parts: {
				isRunning: (id) => world.running.has(id),
				stopAsync: async (id) => {
					world.stopped.push(id);
					world.running.delete(id);
				},
			},
			state: { isAttached: services.studio.status !== "off" },
		},
	};
	return world;
}

/**
 * Studio with the place open: its lock file, and its process.
 *
 * @param world - The session.
 * @param studio - How the process behaves.
 * @returns Its entry in the process table.
 */
function openStudio(world: StopWorld, studio: Partial<FakeProcess> = {}): FakeProcess {
	world.memory.fileSystem.writeFileSync(
		LOCK,
		`${STUDIO_PID}\nRobloxStudioBeta\n${TEST_HOSTNAME}\n4378769e-07d9-4eda-b5ee-187aa6c43cda\n`,
	);
	const entry: FakeProcess = {
		alive: true,
		executablePath: STUDIO,
		onClose: () => {
			world.memory.fileSystem.rmSync(LOCK, { force: true });
		},
		...studio,
	};
	world.native.processes.set(STUDIO_PID, entry);
	return entry;
}

/**
 * Run `action` on the first sleep that reaches `ms`, and on each later one.
 *
 * @param world - The session.
 * @param ms - When.
 * @param action - What happens then.
 */
function atTime(world: StopWorld, ms: number, action: () => void): void {
	world.onSleep.push((now) => {
		if (now >= ms) {
			action();
		}
	});
}

async function stopAsync(world: StopWorld, request: StopPartsRequest): Promise<PartStops> {
	const seams = createTestSeams();
	const stop = createPartStopper(
		{
			config: { studio: { ...DEFAULT_CONFIG.studio, autoRecovery: "keep" } },
			context: createCommandContext({
				seams: {
					...seams,
					clock: world.clock,
					fileSystem: world.memory.fileSystem,
					native: () => world.native.addon,
				},
			}),
			status: {
				phase: world.phase,
				snapshot: () => ({ ...makeStatus(), services: world.services }),
				studio: world.recorded,
			},
		},
		{
			end: (reason) => {
				world.ended.push(reason);
			},
		},
		world.stopper,
	);
	return stop(request);
}

const CLOSED_BY_REQUEST: StudioOutcome = {
	place: PLACE,
	stop: { end: "exited", forced: false, pid: STUDIO_PID, recovery: null, status: "stopped" },
};

describe(createPartStopper, () => {
	it("should close Studio, stop Rojo and the compiler, then end the session for down", async () => {
		expect.assertions(5);

		const world = makeWorld(servicesWith({ compiler: READY, rojo: READY, studio: OPEN }), [
			"compiler",
			"rojo",
		]);
		const studio = openStudio(world);

		await expect(stopAsync(world, DOWN)).resolves.toStrictEqual({
			ending: true,
			kept: [],
			stopped: ["studio", "rojo", "compiler"],
			studio: CLOSED_BY_REQUEST,
		});
		expect(studio).toMatchObject({ alive: false, closeRequests: 1 });
		expect(world.recorded.mock.calls).toStrictEqual([["closed", PLACE, null]]);
		expect({ flushed: world.flushed(), stopped: world.stopped }).toStrictEqual({
			flushed: 1,
			stopped: ["rojo", "compiler"],
		});
		expect({ ended: world.ended, phase: world.phase.mock.calls }).toStrictEqual({
			ended: [{ type: "shutdown" }],
			phase: [["stopping"]],
		});
	});

	it("should end an up session with no part for down, and stop nothing", async () => {
		expect.assertions(2);

		const world = makeWorld(servicesWith());

		await expect(stopAsync(world, DOWN)).resolves.toStrictEqual({
			ending: true,
			kept: [],
			stopped: [],
		});
		expect({ ended: world.ended, flushed: world.flushed() }).toStrictEqual({
			ended: [{ type: "shutdown" }],
			flushed: 0,
		});
	});

	it("should keep owned parts, and the session with them", async () => {
		expect.assertions(2);

		const world = makeWorld(
			servicesWith({
				compiler: { ...READY, ...OWNED },
				rojo: READY,
				studio: { ...OPEN, ...OWNED },
			}),
			["compiler", "rojo"],
		);
		const studio = openStudio(world);

		await expect(stopAsync(world, DOWN)).resolves.toStrictEqual({
			ending: false,
			kept: [
				{ owner: "start", part: "studio" },
				{ owner: "start", part: "compiler" },
			],
			stopped: ["rojo"],
		});
		expect({ alive: studio.alive, ended: world.ended }).toStrictEqual({
			alive: true,
			ended: [],
		});
	});

	it("should keep owned parts for the idle stop, close the Studio with no owner, and go on", async () => {
		expect.assertions(2);

		const world = makeWorld(
			servicesWith({ compiler: { ...READY, ...OWNED }, rojo: READY, studio: OPEN }),
			["compiler", "rojo"],
		);
		const studio = openStudio(world);

		await expect(stopAsync(world, IDLE_STOP)).resolves.toStrictEqual({
			ending: false,
			kept: [{ owner: "start", part: "compiler" }],
			stopped: ["studio", "rojo"],
			studio: CLOSED_BY_REQUEST,
		});
		expect({ alive: studio.alive, ended: world.ended }).toStrictEqual({
			alive: false,
			ended: [],
		});
	});

	it("should keep a session whose only part is an owned Studio", async () => {
		expect.assertions(2);

		const world = makeWorld(servicesWith({ studio: { ...OPEN, ...OWNED } }));

		await expect(stopAsync(world, DOWN)).resolves.toStrictEqual({
			ending: false,
			kept: [{ owner: "start", part: "studio" }],
			stopped: [],
		});
		expect(world.stopper.state.isAttached).toBeTrue();
	});

	it("should keep the Studio of another place attached, also with keepStudio", async () => {
		expect.assertions(2);

		const world = makeWorld(servicesWith({ studio: OPEN }));
		const other = path.join(PROJECT, "other.rbxl");

		await expect(
			stopAsync(world, { ...STOP, keepStudio: true, place: other }),
		).resolves.toStrictEqual({ ending: false, kept: [], stopped: [] });
		expect(world.stopper.state.isAttached).toBeTrue();
	});

	it("should close an owned Studio with force", async () => {
		expect.assertions(2);

		const world = makeWorld(servicesWith({ rojo: READY, studio: { ...OPEN, ...OWNED } }), [
			"rojo",
		]);
		const studio = openStudio(world);

		await expect(stopAsync(world, { ...STOP, force: true })).resolves.toMatchObject({
			ending: true,
			kept: [],
			stopped: ["studio", "rojo"],
		});
		expect(studio.alive).toBeFalse();
	});

	it("should close Studio and stop its Rojo for stop, and keep the session for its compiler", async () => {
		expect.assertions(2);

		const world = makeWorld(servicesWith({ compiler: READY, rojo: READY, studio: OPEN }), [
			"compiler",
			"rojo",
		]);
		openStudio(world);

		await expect(stopAsync(world, STOP)).resolves.toStrictEqual({
			ending: false,
			kept: [],
			stopped: ["studio", "rojo"],
			studio: CLOSED_BY_REQUEST,
		});
		expect({
			attached: world.stopper.state.isAttached,
			ended: world.ended,
			running: [...world.running],
		}).toStrictEqual({ attached: false, ended: [], running: ["compiler"] });
	});

	it("should leave the session alone for stop when it has no Studio", async () => {
		expect.assertions(1);

		const world = makeWorld(servicesWith());

		await expect(stopAsync(world, STOP)).resolves.toStrictEqual({
			ending: false,
			kept: [],
			stopped: [],
		});
	});

	it("should never end the session for restart", async () => {
		expect.assertions(2);

		const world = makeWorld(servicesWith({ compiler: READY }), ["compiler"]);

		await expect(stopAsync(world, { ...DOWN, scope: "restart" })).resolves.toStrictEqual({
			ending: false,
			kept: [],
			stopped: ["compiler"],
		});
		expect(world.ended).toStrictEqual([]);
	});

	it("should report a Studio it cannot verify, keep it and its Rojo for stop", async () => {
		expect.assertions(2);

		const world = makeWorld(servicesWith({ rojo: READY, studio: OPEN }), ["rojo"]);
		const studio = openStudio(world, { executablePath: "/usr/bin/node" });

		await expect(stopAsync(world, STOP)).resolves.toStrictEqual({
			ending: false,
			kept: [],
			stopped: [],
			studio: {
				error: {
					code: "identity_mismatch",
					hint: ANY_TEXT,
					message: `${LOCK} names PID ${STUDIO_PID}, but that process is /usr/bin/node, not Roblox Studio. Nothing was killed.`,
				},
				place: PLACE,
			},
		});
		expect({
			alive: studio.alive,
			attached: world.stopper.state.isAttached,
			running: [...world.running],
		}).toStrictEqual({ alive: true, attached: true, running: ["rojo"] });
	});

	it("should pass on a failure with no hint", async () => {
		expect.assertions(1);

		const world = makeWorld(servicesWith({ studio: OPEN }));
		openStudio(world);
		world.native.addon.pinProcess = () => {
			throw new Error("denied.");
		};

		const { studio } = await stopAsync(world, STOP);

		expect(studio).toStrictEqual({
			error: {
				code: "identity_mismatch",
				message: `Could not verify PID ${STUDIO_PID}: denied. Nothing was killed.`,
			},
			place: PLACE,
		});
	});

	it("should pass on the details of a failure", async () => {
		expect.assertions(1);

		const world = makeWorld(servicesWith({ studio: OPEN }));
		openStudio(world);
		Object.defineProperty(world.native, "addon", {
			get: () => {
				throw new ForgeError("native_missing", "No addon.", {
					details: { reason: "gone" },
				});
			},
		});

		await expect(stopAsync(world, STOP)).resolves.toStrictEqual({
			ending: false,
			kept: [],
			stopped: [],
			studio: {
				error: {
					code: "native_missing",
					details: { reason: "gone" },
					message: "No addon.",
				},
				place: PLACE,
			},
		});
	});

	it("should let go of a Studio it cannot verify for down, and still end the session", async () => {
		expect.assertions(2);

		const world = makeWorld(servicesWith({ rojo: READY, studio: OPEN }), ["rojo"]);
		openStudio(world, { executablePath: "/usr/bin/node" });

		await expect(stopAsync(world, DOWN)).resolves.toMatchObject({
			ending: true,
			stopped: ["rojo"],
			studio: { error: { code: "identity_mismatch" } },
		});
		expect({ ended: world.ended, flushed: world.flushed() }).toStrictEqual({
			ended: [{ type: "shutdown" }],
			flushed: 0,
		});
	});

	it("should leave Studio open with keepStudio, and let the session go", async () => {
		expect.assertions(2);

		const world = makeWorld(servicesWith({ rojo: READY, studio: OPEN }), ["rojo"]);
		const studio = openStudio(world);

		await expect(stopAsync(world, { ...DOWN, keepStudio: true })).resolves.toStrictEqual({
			ending: true,
			kept: [],
			stopped: ["rojo"],
		});
		expect(studio.alive).toBeTrue();
	});

	it("should wait while Studio is opening, then close it", async () => {
		expect.assertions(2);

		// The compiler keeps the session: no syncback wait.
		const world = makeWorld(
			servicesWith({ compiler: READY, studio: { place: PLACE, status: "opening" } }),
			["compiler"],
		);
		const studio = openStudio(world);
		atTime(world, 2000, () => {
			world.services = servicesWith({ compiler: READY, studio: OPEN });
		});

		await expect(stopAsync(world, STOP)).resolves.toMatchObject({
			stopped: ["studio"],
			studio: { stop: { end: "exited", status: "stopped" } },
		});
		expect({ closeRequests: studio.closeRequests, waited: world.now() }).toStrictEqual({
			closeRequests: 1,
			waited: 2000,
		});
	});

	it("should close the Studio forge started through its pin, once the wait ends", async () => {
		expect.assertions(2);

		const world = makeWorld(
			servicesWith({
				compiler: READY,
				studio: {
					pid: STUDIO_PID,
					place: PLACE,
					startTime: String(STUDIO_PID),
					status: "opening",
				},
			}),
			["compiler"],
		);
		const studio = openStudio(world);
		world.memory.fileSystem.rmSync(LOCK);

		await expect(stopAsync(world, STOP)).resolves.toMatchObject({
			studio: { stop: { end: "exited", pid: STUDIO_PID, status: "stopped" } },
		});
		expect({
			alive: studio.alive,
			recorded: world.recorded.mock.calls,
			waited: world.now(),
		}).toStrictEqual({
			alive: false,
			recorded: [["closed", PLACE, { pid: STUDIO_PID, startTime: String(STUDIO_PID) }]],
			waited: STUDIO_OPEN_WAIT_MS,
		});
	});

	it("should touch no Studio that has no place yet", async () => {
		expect.assertions(1);

		const world = makeWorld(servicesWith({ studio: { status: "opening" } }));

		await expect(stopAsync(world, STOP)).resolves.toStrictEqual({
			ending: false,
			kept: [],
			stopped: [],
		});
	});

	it("should end Studio without a save after its close time, keeping its files as asked", async () => {
		expect.assertions(2);

		const world = makeWorld(servicesWith({ studio: OPEN }));
		openStudio(world, { onCloseRequest: "refuse" });

		await expect(stopAsync(world, { ...STOP, recovery: "delete" })).resolves.toMatchObject({
			studio: {
				stop: {
					end: "timeout",
					forced: true,
					recovery: { mode: "delete" },
					status: "stopped",
				},
			},
		});
		expect(world.now()).toBeGreaterThanOrEqual(STUDIO_CLOSE_MS);
	});

	it("should keep the auto-recovery files as the config says when the request says nothing", async () => {
		expect.assertions(1);

		const world = makeWorld(servicesWith({ studio: OPEN }));
		openStudio(world, { onCloseRequest: "dialog" });

		await expect(stopAsync(world, STOP)).resolves.toMatchObject({
			studio: { stop: { end: "dialog", recovery: { mode: "keep" } } },
		});
	});

	it("should end the session once a syncback flush outlives its bound", async () => {
		expect.assertions(2);

		const world = makeWorld(servicesWith({ studio: OPEN }));
		openStudio(world);
		world.stopper.flushSyncbackAsync = async () => Promise.withResolvers<void>().promise;

		await expect(stopAsync(world, STOP)).resolves.toMatchObject({ ending: true });
		expect(world.now()).toBeGreaterThanOrEqual(STUDIO_CLOSED_SYNCBACK_MS);
	});
});
