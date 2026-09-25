import { describe, expect, it, vi } from "vitest";

import { createFakeReaper, createFakeSignals } from "../../test/helpers/fake-reaper.ts";
import type { FakeReaper, FakeReaperOptions, FakeSignals } from "../../test/helpers/fake-reaper.ts";
import { ForgeError } from "../errors.ts";
import type { WorkerReport, WorkerSpec } from "../reaper/protocol.ts";
import type { ReaperLauncher } from "../reaper/reaper-client.ts";
import type { SessionOptions, SessionOutcome } from "./run-session.ts";
import { runSessionAsync } from "./run-session.ts";

const REPORT: WorkerReport = { exitCode: 3, forced: false, incomplete: false, signal: null };
const END = { reports: [{ id: "rojo", report: REPORT }], terminated: true };

interface SessionRun {
	fake: FakeReaper;
	onReady: ReturnType<typeof vi.fn<() => void>>;
	outcome: Promise<SessionOutcome>;
	signals: FakeSignals;
}

function service(id: string): WorkerSpec {
	return { id, args: [], cwd: "/p", env: {}, file: `/bin/${id}` };
}

function startSession(
	reaperOptions: FakeReaperOptions = {},
	services: ReadonlyArray<WorkerSpec> = [service("rojo")],
	signals: FakeSignals = createFakeSignals(),
): SessionRun {
	const fake = createFakeReaper({ end: END, ...reaperOptions });
	const onReady = vi.fn<() => void>();
	const options: SessionOptions = {
		graceMs: 250,
		leasePath: "/p/.forge/sessions/s/workers.lock",
		onReady,
		services,
		sessionId: "s",
	};
	const outcome = runSessionAsync({ reaper: fake.launch, signals: signals.signals }, options);
	return { fake, onReady, outcome, signals };
}

async function flushAsync(): Promise<void> {
	await new Promise((resolve) => {
		setImmediate(resolve);
	});
}

describe(runSessionAsync, () => {
	it("should admit the reaper, start every service, and end on a stop signal", async () => {
		expect.assertions(4);

		const { fake, onReady, outcome, signals } = startSession({}, [
			service("rojo"),
			service("compiler"),
		]);
		await flushAsync();
		signals.fire("SIGINT");

		await expect(outcome).resolves.toStrictEqual({
			end: END,
			reason: { signal: "SIGINT", type: "signal" },
		});
		expect(fake.launches).toStrictEqual([
			{ leasePath: "/p/.forge/sessions/s/workers.lock", sessionId: "s" },
		]);
		expect(fake.calls).toStrictEqual(["go", "spawn rojo", "spawn compiler", "terminate 250"]);
		expect([onReady.mock.calls.length, signals.listeners()]).toStrictEqual([1, 0]);
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

	it("should never admit the reaper after a stop signal during its launch", async () => {
		expect.assertions(3);

		const signals = createFakeSignals();
		const { fake, onReady, outcome } = startSession(
			{
				onLaunch: () => {
					signals.fire("SIGHUP");
				},
			},
			[service("rojo")],
			signals,
		);

		await expect(outcome).resolves.toMatchObject({
			reason: { signal: "SIGHUP", type: "signal" },
		});
		expect(fake.calls).toStrictEqual(["terminate 250"]);
		expect(onReady).not.toHaveBeenCalled();
	});

	it("should start no further service after a stop signal", async () => {
		expect.assertions(3);

		const signals = createFakeSignals();
		const { fake, onReady, outcome } = startSession(
			{
				onSpawn: () => {
					signals.fire("SIGTERM");
					signals.fire("SIGINT");
				},
			},
			[service("rojo"), service("compiler")],
			signals,
		);

		await expect(outcome).resolves.toMatchObject({
			reason: { signal: "SIGTERM", type: "signal" },
		});
		expect(fake.calls).toStrictEqual(["go", "spawn rojo", "terminate 250"]);
		expect(onReady).not.toHaveBeenCalled();
	});

	it("should terminate the reaper and rethrow when a service cannot start", async () => {
		expect.assertions(3);

		const error = new ForgeError("process_failed", "no rojo");
		const { fake, outcome, signals } = startSession({ spawnError: error });

		await expect(outcome).rejects.toBe(error);
		expect(fake.calls).toStrictEqual(["go", "spawn rojo", "terminate 250"]);
		expect(signals.listeners()).toBe(0);
	});

	it("should stop listening for signals when the reaper cannot launch", async () => {
		expect.assertions(2);

		const signals = createFakeSignals();
		const error = new ForgeError("reaper_unavailable", "no reaper");
		const outcome = runSessionAsync(
			{ reaper: vi.fn<ReaperLauncher>().mockRejectedValue(error), signals: signals.signals },
			{
				graceMs: 0,
				leasePath: "/l",
				onReady: vi.fn<() => void>(),
				services: [],
				sessionId: "s",
			},
		);

		await expect(outcome).rejects.toBe(error);
		expect(signals.listeners()).toBe(0);
	});
});
