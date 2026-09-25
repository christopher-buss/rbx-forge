import { describe, expect, it, vi } from "vitest";

import { createFakeReaper, createFakeSignals } from "../../test/helpers/fake-reaper.ts";
import type { FakeReaper, FakeReaperOptions, FakeSignals } from "../../test/helpers/fake-reaper.ts";
import { ForgeError } from "../errors.ts";
import type { WorkerReport, WorkerSpec } from "../reaper/protocol.ts";
import type { ReaperLauncher } from "../reaper/reaper-client.ts";
import { neverPauseAsync } from "./pause.ts";
import type { Pause, PausePoint } from "./pause.ts";
import type { SessionOutcome, SessionScope } from "./run-session.ts";
import { runSessionAsync } from "./run-session.ts";

const REPORT: WorkerReport = { exitCode: 3, forced: false, incomplete: false, signal: null };
const END = { reports: [{ id: "rojo", report: REPORT }], terminated: true };
const OPTIONS = {
	graceMs: 250,
	leasePath: "/p/.forge/sessions/s/workers.lock",
	recordPath: "/p/.forge/sessions/s/reaper.json",
	sessionId: "s",
};

interface SessionRun {
	fake: FakeReaper;
	outcome: Promise<SessionOutcome>;
	signals: FakeSignals;
}

function service(id: string): WorkerSpec {
	return { id, args: [], cwd: "/p", env: {}, file: `/bin/${id}` };
}

async function startServicesAsync(scope: SessionScope, ids: ReadonlyArray<string>): Promise<void> {
	for (const id of ids) {
		await scope.startServiceAsync(service(id));
	}
}

function startSession(
	body: (scope: SessionScope) => Promise<void> = async (scope) => {
		await startServicesAsync(scope, ["rojo"]);
	},
	reaperOptions: FakeReaperOptions = {},
	signals: FakeSignals = createFakeSignals(),
	pause: Pause = neverPauseAsync,
): SessionRun {
	const fake = createFakeReaper({ end: END, ...reaperOptions });
	const outcome = runSessionAsync(
		{ pause, reaper: fake.launch },
		{ ...OPTIONS, onStop: signals.onStop },
		body,
	);
	return { fake, outcome, signals };
}

/**
 * A pause that closes the owner pipe at `point` and records each point it
 * passes, with whether the session had ended by the end of the pause.
 *
 * @param point - Where the owner goes.
 * @param signals - Sends the request.
 * @param points - Gets `<point>` or `<point> aborted`.
 * @returns The pause.
 */
function ownerGoesAt(point: PausePoint, signals: FakeSignals, points: Array<string>): Pause {
	return async (at, signal) => {
		if (at === point) {
			signals.request({ type: "owner_gone" });
		}

		points.push(signal.aborted ? `${at} aborted` : at);
	};
}

async function flushAsync(): Promise<void> {
	await new Promise((resolve) => {
		setImmediate(resolve);
	});
}

describe(runSessionAsync, () => {
	it("should admit the reaper, run the body, and end on a stop signal", async () => {
		expect.assertions(4);

		const { fake, outcome, signals } = startSession(async (scope) => {
			await startServicesAsync(scope, ["rojo", "compiler"]);
		});
		await flushAsync();
		signals.fire("SIGINT");

		await expect(outcome).resolves.toStrictEqual({
			end: END,
			reason: { signal: "SIGINT", type: "signal" },
		});
		expect(fake.launches).toStrictEqual([
			{
				leasePath: "/p/.forge/sessions/s/workers.lock",
				recordPath: "/p/.forge/sessions/s/reaper.json",
				sessionId: "s",
			},
		]);
		expect(fake.calls).toStrictEqual(["go", "spawn rojo", "spawn compiler", "terminate 250"]);
		expect(signals.listeners()).toBe(0);
	});

	it("should end when a service exits, with its report", async () => {
		expect.assertions(2);

		const { fake, outcome } = startSession();
		await flushAsync();
		fake.exit("rojo", REPORT);

		await expect(outcome).resolves.toStrictEqual({
			end: END,
			reason: { report: REPORT, service: "rojo", type: "service_exited" },
		});
		expect(fake.calls).toStrictEqual(["go", "spawn rojo", "terminate 250"]);
	});

	it("should keep the first reason it ends with", async () => {
		expect.assertions(1);

		const { outcome, signals } = startSession(async (scope) => {
			scope.end({ type: "studio_closed" });
			scope.end({ error: new Error("late"), type: "failed" });
		});
		await flushAsync();
		signals.fire("SIGINT");

		await expect(outcome).resolves.toMatchObject({ reason: { type: "studio_closed" } });
	});

	it("should never admit the reaper or run the body after a stop signal during its launch", async () => {
		expect.assertions(3);

		const signals = createFakeSignals();
		const body = vi.fn<(scope: SessionScope) => Promise<void>>();
		const { fake, outcome } = startSession(
			body,
			{
				onLaunch: () => {
					signals.fire("SIGHUP");
				},
			},
			signals,
		);

		await expect(outcome).resolves.toMatchObject({
			reason: { signal: "SIGHUP", type: "signal" },
		});
		expect(fake.calls).toStrictEqual(["terminate 250"]);
		expect(body).not.toHaveBeenCalled();
	});

	it("should start no further service after a stop signal", async () => {
		expect.assertions(3);

		const signals = createFakeSignals();
		const started: Array<unknown> = [];
		const { fake, outcome } = startSession(
			async (scope) => {
				started.push(
					await scope.startServiceAsync(service("rojo")),
					await scope.startServiceAsync(service("compiler")),
				);
			},
			{
				onSpawn: () => {
					signals.fire("SIGTERM");
					signals.fire("SIGINT");
				},
			},
			signals,
		);

		await expect(outcome).resolves.toMatchObject({
			reason: { signal: "SIGTERM", type: "signal" },
		});
		expect(fake.calls).toStrictEqual(["go", "spawn rojo", "terminate 250"]);
		expect(started).toStrictEqual([expect.objectContaining({ id: "rojo" }), undefined]);
	});

	it("should end with failed and terminate the reaper when the body rejects", async () => {
		expect.assertions(3);

		const error = new ForgeError("process_failed", "no rojo");
		const { fake, outcome, signals } = startSession(undefined, { spawnError: error });

		await expect(outcome).resolves.toStrictEqual({
			end: END,
			reason: { error, type: "failed" },
		});
		expect(fake.calls).toStrictEqual(["go", "spawn rojo", "terminate 250"]);
		expect(signals.listeners()).toBe(0);
	});

	it("should abort the scope's signal once the session ends", async () => {
		expect.assertions(1);

		let scopeSignal: AbortSignal | undefined;
		const { outcome, signals } = startSession(async (scope) => {
			scopeSignal = scope.signal;
		});
		await flushAsync();
		signals.fire("SIGINT");
		await outcome;

		expect(scopeSignal).toHaveProperty("aborted", true);
	});

	it("should wait for every tracked task after the reaper ended, even ones added late", async () => {
		expect.assertions(1);

		const order: Array<string> = [];
		const { outcome, signals } = startSession(async (scope) => {
			const { promise, resolve } = Promise.withResolvers<void>();
			scope.signal.addEventListener("abort", () => {
				setImmediate(() => {
					resolve();
				});
			});
			async function lateAsync(): Promise<void> {
				await flushAsync();
				order.push("late");
			}

			async function firstAsync(): Promise<void> {
				await promise;
				order.push("first");
				scope.track(lateAsync());
			}

			scope.track(firstAsync());
		});
		await flushAsync();
		signals.fire("SIGINT");
		await outcome;
		order.push("returned");

		expect(order).toStrictEqual(["first", "late", "returned"]);
	});

	it("should wait for a body that still runs when the session ends", async () => {
		expect.assertions(1);

		const order: Array<string> = [];
		const { outcome, signals } = startSession(async (scope) => {
			await new Promise((resolve) => {
				scope.signal.addEventListener("abort", () => {
					setImmediate(resolve);
				});
			});
			order.push("body");
		});
		await flushAsync();
		signals.fire("SIGINT");
		await outcome;
		order.push("returned");

		expect(order).toStrictEqual(["body", "returned"]);
	});

	it("should stop listening for signals when the reaper cannot launch", async () => {
		expect.assertions(2);

		const signals = createFakeSignals();
		const error = new ForgeError("reaper_unavailable", "no reaper");
		const outcome = runSessionAsync(
			{ pause: neverPauseAsync, reaper: vi.fn<ReaperLauncher>().mockRejectedValue(error) },
			{ ...OPTIONS, onStop: signals.onStop },
			vi.fn<(scope: SessionScope) => Promise<void>>(),
		);

		await expect(outcome).rejects.toBe(error);
		expect(signals.listeners()).toBe(0);
	});

	it("should end with owner_gone when the owner pipe closes", async () => {
		expect.assertions(1);

		const { outcome, signals } = startSession();
		await flushAsync();
		signals.request({ type: "owner_gone" });

		await expect(outcome).resolves.toMatchObject({ reason: { type: "owner_gone" } });
	});

	it("should end at once on a stop request that came before the session", async () => {
		expect.assertions(2);

		const signals = createFakeSignals();
		const body = vi.fn<(scope: SessionScope) => Promise<void>>();
		const { fake, outcome } = startSession(
			body,
			{},
			{
				...signals,
				onStop: (listener) => {
					listener({ type: "owner_gone" });
					return signals.onStop(listener);
				},
			},
		);

		await expect(outcome).resolves.toMatchObject({ reason: { type: "owner_gone" } });
		expect([fake.calls, body.mock.calls]).toStrictEqual([["terminate 250"], []]);
	});

	it.for<[PausePoint, Array<string>]>([
		["leased", ["terminate 250"]],
		["admitted", ["go", "terminate 250"]],
	])(
		"should close admission for good when the owner goes while paused at %s",
		async ([point, calls]) => {
			expect.assertions(2);

			const signals = createFakeSignals();
			const points: Array<string> = [];
			const body = vi.fn<(scope: SessionScope) => Promise<void>>();
			const pause = ownerGoesAt(point, signals, points);
			const { fake, outcome } = startSession(body, {}, signals, pause);
			await outcome;

			expect(fake.calls).toStrictEqual(calls);
			expect([points.at(-1), body.mock.calls]).toStrictEqual([`${point} aborted`, []]);
		},
	);

	it("should pause at leased before go and at admitted before the body", async () => {
		expect.assertions(1);

		const order: Array<string> = [];
		const { fake, outcome, signals } = startSession(
			async () => {
				order.push(...fake.calls, "body");
			},
			{},
			createFakeSignals(),
			async (point) => {
				order.push(...fake.calls.splice(0), point);
			},
		);
		await flushAsync();
		signals.fire("SIGINT");
		await outcome;

		expect(order).toStrictEqual(["leased", "go", "admitted", "body"]);
	});
});
