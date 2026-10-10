import path from "node:path";
import { assert, describe, expect, it } from "vitest";

import { createFakeSpawner } from "../../test/helpers/fake-process.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import { createMemoryFileSystem, createTestSeams, PROJECT } from "../../test/helpers/seams.ts";
import { STUDIO_OPEN_BOUND_MS } from "../session/studio-readiness.ts";
import {
	createKeepHiddenLauncher,
	KEEP_HIDDEN_FLAG,
	KEEP_HIDDEN_POLL_MS,
	KEEP_HIDDEN_QUIET_MS,
	keepStudioHiddenAsync,
} from "./keep-hidden.ts";

const PLACE = path.join(PROJECT, "game.rbxl");
const TARGET = { pid: 42, place: PLACE, startTime: "42" };
const STATE = path.join(PROJECT, ".forge", "sessions", "s1", "state.json");

interface Script {
	/** A save activates Studio (priming its save menu) at this time. */
	activatesAt?: number;
	/** Another app becomes active at this time, leaving Studio shown. */
	deactivatesAt?: number;
	/** Studio exits at this time. */
	exitsAt?: number;
	/** Its place lock appears at this time. */
	opensAt?: number;
	/** What the session that `forge show` writes records for Studio. */
	recorded?: Parameters<typeof sessionState>;
	/** Studio shows itself at these times. */
	showsAt?: Array<number>;
	/**
	 * `forge show` records the `user` desktop and shows Studio at this time.
	 */
	userShowsAt?: number;
}

function sessionState(
	desktop: "hidden" | "user",
	studio: { pid?: number; startTime?: string } = {},
) {
	return {
		phase: "ready",
		pid: 7,
		running: true,
		services: {
			compiler: { building: false, owner: null, status: "off" },
			rojo: { owner: null, status: "off" },
			studio: {
				desktop,
				owner: "start",
				pid: 42,
				place: PLACE,
				startTime: "42",
				status: "open",
				...studio,
			},
			syncback: { status: "off" },
		},
		sessionId: "s1",
		startedAt: "2026-01-01T00:00:00.000Z",
	};
}

function watching({
	activatesAt,
	deactivatesAt,
	exitsAt,
	opensAt,
	recorded = ["user"],
	showsAt = [],
	userShowsAt,
}: Script = {}) {
	let now = 0;
	const memory = createMemoryFileSystem({ "game.rbxl": "place" });
	const native = createFakeNative({
		42: { alive: true, appHidden: true, executablePath: "RobloxStudio", startTime: "42" },
	});
	const studio = native.processes.get(42);
	assert(studio !== undefined);
	const shows: Array<number> = [];
	const hides: Array<number> = [];
	const pending = [...showsAt];
	let didUserShow = false;
	const seams = createTestSeams({
		clock: {
			now: () => now,
			sleep: async (ms) => {
				now += ms;
				if (pending[0] !== undefined && now >= pending[0]) {
					pending.shift();
					studio.appHidden = false;
					shows.push(now);
				}

				if (!didUserShow && userShowsAt !== undefined && now >= userShowsAt) {
					didUserShow = true;
					memory.fileSystem.mkdirSync(path.dirname(STATE), { recursive: true });
					// A session directory without a state yet.
					memory.fileSystem.mkdirSync(path.join(PROJECT, ".forge", "sessions", "s0"), {
						recursive: true,
					});
					memory.fileSystem.writeFileSync(
						STATE,
						JSON.stringify(sessionState(...recorded)),
					);
					studio.appHidden = false;
				}

				if (activatesAt !== undefined && now === activatesAt) {
					native.addon.pinProcess(42)?.activateApp();
				}

				if (deactivatesAt !== undefined && now === deactivatesAt) {
					studio.appActive = false;
				}

				if (opensAt !== undefined && now >= opensAt) {
					memory.fileSystem.writeFileSync(`${PLACE}.lock`, "42\nRobloxStudio\nhost\n");
				}

				if (exitsAt !== undefined && now >= exitsAt) {
					studio.alive = false;
				}
			},
		},
		fileSystem: memory.fileSystem,
		native: () => native.addon,
	});
	return {
		hides,
		now: () => now,
		run: async (target: Record<string, number | string> = TARGET) => {
			const pinProcess = native.addon.pinProcess.bind(native.addon);
			native.addon.pinProcess = (pid) => {
				const pinned = pinProcess(pid);
				return pinned === null
					? null
					: {
							...pinned,
							setAppHidden: (hidden) => {
								hides.push(now);
								return pinned.setAppHidden(hidden);
							},
						};
			};

			await keepStudioHiddenAsync(seams, JSON.stringify(target), PROJECT);
		},
		shows,
		studio,
	};
}

describe(keepStudioHiddenAsync, () => {
	it("should hide Studio again within one poll every time it shows itself", async () => {
		expect.assertions(3);

		const run = watching({ opensAt: 5000, showsAt: [1700, 3100, 3900, 4200] });
		await run.run();

		expect(run.hides).toStrictEqual(run.shows);
		expect(run.hides).toHaveLength(4);
		expect(run.studio.appHidden).toBeTrue();
	});

	it("should stop once the place is open and Studio stayed hidden for the quiet window", async () => {
		expect.assertions(1);

		const run = watching({ opensAt: 5000, showsAt: [4200] });
		await run.run();

		expect(run.now()).toBe(5000 + KEEP_HIDDEN_QUIET_MS);
	});

	it("should restart the quiet window when Studio shows itself after its place opens", async () => {
		expect.assertions(1);

		const run = watching({ opensAt: 1000, showsAt: [2000] });
		await run.run();

		expect(run.now()).toBe(2000 + KEEP_HIDDEN_QUIET_MS);
	});

	it("should leave Studio shown once its session records the user desktop", async () => {
		expect.assertions(2);

		const run = watching({ opensAt: 5000, showsAt: [1000], userShowsAt: 2000 });
		await run.run();

		expect(run.hides).toStrictEqual([1000]);
		expect(run.studio.appHidden).toBeFalse();
	});

	it("should hide Studio again when its session records another Studio's start time", async () => {
		expect.assertions(1);

		const run = watching({
			opensAt: 5000,
			recorded: ["user", { startTime: "41" }],
			userShowsAt: 2000,
		});
		await run.run();

		expect(run.hides).toStrictEqual([2000]);
	});

	it("should hide Studio again when its session records another Studio's PID", async () => {
		expect.assertions(1);

		const run = watching({ opensAt: 5000, recorded: ["user", { pid: 43 }], userShowsAt: 2000 });
		await run.run();

		expect(run.hides).toStrictEqual([2000]);
	});

	it("should hide Studio again when its session records the hidden desktop", async () => {
		expect.assertions(1);

		const run = watching({ opensAt: 5000, recorded: ["hidden"], userShowsAt: 2000 });
		await run.run();

		expect(run.hides).toStrictEqual([2000]);
	});

	it("should leave Studio shown while it is the active app, then hide it once it is not", async () => {
		expect.assertions(3);

		const run = watching({ activatesAt: 2000, deactivatesAt: 4000, opensAt: 1000 });
		await run.run();

		expect(run.hides).toStrictEqual([4000]);
		expect(run.studio.appHidden).toBeTrue();
		expect(run.now()).toBe(4000 + KEEP_HIDDEN_QUIET_MS);
	});

	it("should stop when Studio exits", async () => {
		expect.assertions(1);

		const run = watching({ exitsAt: 500 });
		await run.run();

		expect(run.now()).toBe(500);
	});

	it("should stop at the open bound when the place never opens", async () => {
		expect.assertions(1);

		const run = watching();
		await run.run();

		expect(run.now()).toBe(STUDIO_OPEN_BOUND_MS);
	});

	it("should leave a process alone whose start time differs", async () => {
		expect.assertions(1);

		const run = watching({ showsAt: [KEEP_HIDDEN_POLL_MS] });
		await run.run({ pid: 42, place: PLACE, startTime: "41" });

		expect(run.now()).toBe(0);
	});

	it("should leave a missing process alone", async () => {
		expect.assertions(1);

		const run = watching();
		await run.run({ pid: 43, place: PLACE, startTime: "43" });

		expect(run.now()).toBe(0);
	});

	it("should reject a malformed target", async () => {
		expect.assertions(1);

		const run = watching();

		await expect(run.run({ pid: 0, place: PLACE, startTime: "42" })).rejects.toThrow("pid");
	});
});

describe("windows detached window hiding", () => {
	it("ends without polling when Studio exits before its watcher starts", async () => {
		expect.assertions(1);

		const native = createFakeNative({ 42: { alive: true, executablePath: "RobloxStudio" } });
		const pinned = native.addon.pinProcess(42)!;
		native.addon.pinProcess = () => {
			return {
				...pinned,
				startWindowHiding: () => false,
				windowHiding: () => {
					throw new Error("watcher did not start");
				},
			};
		};

		let sleeps = 0;
		const seams = createTestSeams({
			clock: {
				now: () => 0,
				sleep: async () => {
					sleeps++;
				},
			},
			native: () => native.addon,
		});
		await keepStudioHiddenAsync(seams, JSON.stringify({ ...TARGET, isWindows: true }), PROJECT);

		expect(sleeps).toBe(0);
	});

	it.for(["exit", "stop"] as const)(
		"keeps the helper alive until the watcher %s",
		async (end) => {
			expect.assertions(3);

			const native = createFakeNative({
				42: { alive: true, executablePath: "RobloxStudio", windowVisibility: "hidden" },
			});
			const studio = native.processes.get(42)!;
			let elapsed = 0;
			const seams = createTestSeams({
				clock: {
					now: () => elapsed,
					sleep: async (ms) => {
						elapsed += ms;

						expect(studio.windowHiding).toBeTrue();

						studio.alive = end !== "exit";
						studio.windowHiding = end !== "stop";
					},
				},
				native: () => native.addon,
			});
			await keepStudioHiddenAsync(
				seams,
				JSON.stringify({ ...TARGET, isWindows: true }),
				PROJECT,
			);

			expect(elapsed).toBe(KEEP_HIDDEN_POLL_MS);
			expect(studio.windowVisibility).toBe("hidden");
		},
	);
});

describe(createKeepHiddenLauncher, () => {
	it("should ignore a watcher that fails to start after the spawn returns", async () => {
		expect.assertions(1);

		const spawner = createFakeSpawner((child) => {
			child.error(new Error("spawn /node ENOENT"));
		});
		const launch = createKeepHiddenLauncher(
			{ childProcess: spawner.runner, host: createTestSeams().host },
			"/forge/supervisor.mjs",
		);
		launch({ cwd: "/project", env: {}, target: TARGET });
		await new Promise((resolve) => {
			setImmediate(resolve);
		});

		expect(spawner.children[0]!.referenced).toBeFalse();
	});

	it("should start the watcher detached through the supervisor entry, with no pipes", () => {
		expect.assertions(2);

		const spawner = createFakeSpawner();
		const launch = createKeepHiddenLauncher(
			{ childProcess: spawner.runner, host: createTestSeams().host },
			"/forge/supervisor.mjs",
		);
		launch({
			cwd: "/project",
			env: { PATH: "/bin" },
			target: { pid: 42, place: PLACE, startTime: "42" },
		});

		expect(spawner.calls[0]).toMatchObject({
			args: [
				"/forge/supervisor.mjs",
				KEEP_HIDDEN_FLAG,
				JSON.stringify({ pid: 42, place: PLACE, startTime: "42" }),
			],
			file: "/node",
			options: {
				cwd: "/project",
				detached: true,
				env: { PATH: "/bin" },
				stdio: "ignore",
				windowsHide: true,
			},
		});
		expect(spawner.children[0]!.referenced).toBeFalse();
	});
});
