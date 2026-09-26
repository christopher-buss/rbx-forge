import path from "node:path";
import { describe, expect, it } from "vitest";

import { createFakeReaper } from "../../test/helpers/fake-reaper.ts";
import type { FakeReaper } from "../../test/helpers/fake-reaper.ts";
import { createManualClock } from "../../test/helpers/manual-clock.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createRecordingReporter,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import type { RecordingReporter } from "../../test/helpers/seams.ts";
import type { WorkerReport } from "../reaper/protocol.ts";
import type { SessionScope } from "./run-session.ts";
import type { ServiceInvocation, ServiceParts } from "./service-parts.ts";
import { createServiceParts } from "./service-parts.ts";
import type { StatusStore } from "./status.ts";
import { createStatusStore } from "./status.ts";

const EXITED: WorkerReport = { exitCode: 1, forced: false, incomplete: false, signal: null };
const ROJO: ServiceInvocation = {
	id: "rojo",
	args: ["serve"],
	file: "/bin/rojo",
	step: "rojo serve",
};
const DIRECTORY = path.join(PROJECT, ".forge", "sessions", "s1");

interface PartsRun {
	abort: AbortController;
	fake: FakeReaper;
	parts: ServiceParts;
	reporter: RecordingReporter;
	status: StatusStore;
	/** Every task the parts gave the scope to track. */
	tracked: Array<Promise<unknown>>;
}

/**
 * Service parts over a fake reaper and a real status store.
 *
 * @param isEnding - The session is ending: its scope starts nothing.
 * @returns The parts, their reaper, status, and reporter.
 */
async function makePartsAsync(isEnding = false): Promise<PartsRun> {
	const fake = createFakeReaper();
	const reaper = await fake.launch({ leasePath: "l", recordPath: "r", sessionId: "s1" });
	const abort = new AbortController();
	const tracked: Array<Promise<unknown>> = [];
	const reporter = createRecordingReporter();
	const clock = createManualClock(Date.UTC(2026, 0, 1));
	const context = createCommandContext({
		reporter,
		seams: createTestSeams({
			clock: clock.clock,
			fileSystem: createMemoryFileSystem().fileSystem,
		}),
	});
	const scope: SessionScope = {
		end: () => {
			abort.abort();
		},
		reaper,
		signal: abort.signal,
		startServiceAsync: async (service) => (isEnding ? undefined : reaper.spawnAsync(service)),
		stopWorker: (id) => {
			reaper.stop(id, 100);
		},
		track: (task) => {
			tracked.push(task);
		},
	};
	const status = createStatusStore(
		{
			compiler: false,
			open: false,
			owner: null,
			pid: 1,
			port: 34_872,
			rojo: true,
			sessionId: "s1",
			startedAt: "t",
			syncback: false,
		},
		() => 0,
		() => {},
	);
	const parts = createServiceParts({ context, directory: DIRECTORY, status }, scope);
	return { abort, fake, parts, reporter, status, tracked };
}

describe(createServiceParts, () => {
	it("should mark a part stopped on request off, not failed", async () => {
		expect.assertions(3);

		const run = await makePartsAsync();
		const rojo = await run.parts.startAsync(ROJO, { initial: "starting" });
		run.parts.stop("rojo");
		run.parts.stop("rojo");
		run.fake.exit("rojo", EXITED);
		await rojo!.stopped;

		expect(run.fake.calls).toStrictEqual(["spawn rojo", "stop rojo 100"]);
		expect(run.status.snapshot().services.rojo).toStrictEqual({
			owner: null,
			port: 34_872,
			status: "off",
		});
		expect(run.reporter.events).not.toContainEqual(
			expect.objectContaining({ type: "warning" }),
		);
	});

	it("should have the session track each part until its status tells how it ended", async () => {
		expect.assertions(2);

		const run = await makePartsAsync();
		const rojo = await run.parts.startAsync(ROJO, { initial: "ready" });

		expect(run.tracked).toStrictEqual([rojo!.stopped]);

		run.fake.exit("rojo", EXITED);
		await Promise.all(run.tracked);

		expect(run.status.snapshot().services.rojo.status).toBe("failed");
	});

	it("should mark the parts off when the session ends", async () => {
		expect.assertions(1);

		const run = await makePartsAsync();
		const rojo = await run.parts.startAsync(ROJO, { initial: "ready" });
		run.abort.abort();
		run.fake.exit("rojo", EXITED);
		await rojo!.stopped;

		expect(run.status.snapshot().services.rojo.status).toBe("off");
	});

	it("should do nothing to stop a part that does not run", async () => {
		expect.assertions(1);

		const run = await makePartsAsync();
		const rojo = await run.parts.startAsync(ROJO, { initial: "ready" });
		run.fake.exit("rojo", EXITED);
		await rojo!.stopped;
		run.parts.stop("rojo");
		run.parts.stop("compiler");

		expect(run.fake.calls).toStrictEqual(["spawn rojo"]);
	});

	it("should stop a part on request and wait until its tree is gone", async () => {
		expect.assertions(3);

		const run = await makePartsAsync();
		await run.parts.startAsync(ROJO, { initial: "ready" });
		const stopping = run.parts.stopAsync("rojo");
		const early = await Promise.race([
			stopping.then(() => "stopped"),
			Promise.resolve("waiting"),
		]);
		run.fake.exit("rojo", EXITED);
		await stopping;

		expect(early).toBe("waiting");
		expect(run.fake.calls).toStrictEqual(["spawn rojo", "stop rojo 100"]);
		expect(run.status.snapshot().services.rojo.status).toBe("off");
	});

	it("should stop a part that does not run at once", async () => {
		expect.assertions(2);

		const run = await makePartsAsync();

		await expect(run.parts.stopAsync("compiler")).resolves.toBeUndefined();
		expect(run.fake.calls).toStrictEqual([]);
	});

	it("should note a tree that left processes, until the part's next tree is gone", async () => {
		expect.assertions(3);

		const run = await makePartsAsync();
		await run.parts.startAsync(ROJO, { initial: "ready" });
		const hasBefore = run.parts.hasSurvivors("rojo");
		const stopping = run.parts.stopAsync("rojo");
		run.fake.exit("rojo", { ...EXITED, incomplete: true });
		await stopping;
		const hasAfter = run.parts.hasSurvivors("rojo");
		await run.parts.startAsync(ROJO, { initial: "ready" });
		const stoppingAgain = run.parts.stopAsync("rojo");
		run.fake.exit("rojo", EXITED);
		await stoppingAgain;

		expect(hasBefore).toBeFalse();
		expect(hasAfter).toBeTrue();
		expect(run.parts.hasSurvivors("rojo")).toBeFalse();
	});

	it("should start nothing once the session is ending", async () => {
		expect.assertions(2);

		const run = await makePartsAsync(true);

		await expect(run.parts.startAsync(ROJO, { initial: "ready" })).resolves.toBeUndefined();
		expect(run.status.snapshot().services.rojo.status).toBe("starting");
	});
});
