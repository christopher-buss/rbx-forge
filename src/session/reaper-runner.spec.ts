import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createFakeReaper } from "../../test/helpers/fake-reaper.ts";
import type { FakeReaper, FakeReaperOptions } from "../../test/helpers/fake-reaper.ts";
import { createManualClock } from "../../test/helpers/manual-clock.ts";
import type { ManualClock } from "../../test/helpers/manual-clock.ts";
import { createMemoryFileSystem, PROJECT } from "../../test/helpers/seams.ts";
import type { MemoryFileSystem } from "../../test/helpers/seams.ts";
import { ForgeError } from "../errors.ts";
import { openLogFile } from "../output/log-file.ts";
import type { ProcessOutcome, ProcessRunner, ProcessSpec } from "../process/process-runner.ts";
import type { WorkerReport } from "../reaper/protocol.ts";
import type { Reaper } from "../reaper/reaper-client.ts";
import { createReaperRunner } from "./reaper-runner.ts";

const SPOOL = path.join(PROJECT, ".forge", "sessions", "s", "output");
const LOG = path.join(PROJECT, ".forge", "logs", "start.log");
const SPEC: ProcessSpec = {
	args: ["build", "x"],
	cwd: PROJECT,
	env: { A: "1" },
	file: "/bin/rojo",
};
const OK: WorkerReport = { exitCode: 0, forced: false, incomplete: false, signal: null };

interface RunnerSetup {
	abort: AbortController;
	clock: ManualClock;
	fake: FakeReaper;
	memory: MemoryFileSystem;
	reaper: Reaper;
	runner: ProcessRunner;
}

async function setupAsync(options: FakeReaperOptions = {}): Promise<RunnerSetup> {
	const memory = createMemoryFileSystem();
	const clock = createManualClock(1000);
	const fake = createFakeReaper(options);
	const reaper = await fake.launch({
		leasePath: "/lease",
		recordPath: "/record",
		sessionId: "s",
	});
	const abort = new AbortController();
	const runner = createReaperRunner({
		name: "start",
		clock: clock.clock,
		fileSystem: memory.fileSystem,
		log: openLogFile(memory.fileSystem, LOG),
		reaper,
		signal: abort.signal,
		spoolDirectory: SPOOL,
	});
	return { abort, clock, fake, memory, reaper, runner };
}

async function flushAsync(): Promise<void> {
	await new Promise((resolve) => {
		setImmediate(resolve);
	});
}

/**
 * Write a run's output where the reaper would, then end it.
 *
 * @param setup - The runner.
 * @param output - What the run wrote.
 * @param report - How it ended.
 */
async function finishAsync(
	setup: RunnerSetup,
	output: string,
	report: Partial<WorkerReport> = {},
): Promise<void> {
	await flushAsync();
	const spawned = setup.fake.spawned.at(-1)!;
	setup.memory.fileSystem.writeFileSync(spawned.log!, output);
	setup.clock.advance(25);
	setup.fake.exit(spawned.id, { ...OK, ...report });
}

describe(createReaperRunner, () => {
	it("should run the process as a reaper worker with its output in a spool file", async () => {
		expect.assertions(1);

		const setup = await setupAsync();
		const outcome = setup.runner({ ...SPEC, verbatimArguments: true });
		await finishAsync(setup, "");
		await outcome;

		expect(setup.fake.spawned).toStrictEqual([
			{
				id: "start-1",
				args: ["build", "x"],
				cwd: PROJECT,
				env: { A: "1" },
				file: "/bin/rojo",
				log: path.join(SPOOL, "start-1.log"),
				verbatimArguments: true,
			},
		]);
	});

	it("should report the exit, hand every line over, log it, and remove the spool", async () => {
		expect.assertions(3);

		const setup = await setupAsync();
		const onLine = vi.fn<(line: string) => void>();
		const outcome = setup.runner({ ...SPEC, onLine });
		await finishAsync(setup, "\u001B[31m-red-\u001B[39m\nlast", { exitCode: 2 });

		await expect(outcome).resolves.toStrictEqual<ProcessOutcome>({
			durationMs: 25,
			exitCode: 2,
			outputTail: ["\u001B[31m-red-\u001B[39m", "last"],
			signal: null,
			type: "exited",
		});
		expect(onLine.mock.calls).toStrictEqual([["\u001B[31m-red-\u001B[39m"], ["last"]]);
		expect(setup.memory.files()).toStrictEqual({
			".forge/logs/start.log": "--- start-1: /bin/rojo build x ---\n-red-\nlast\n",
			".forge/sessions/s/output": null,
		});
	});

	it("should keep only the last 50 lines", async () => {
		expect.assertions(1);

		const setup = await setupAsync();
		const outcome = setup.runner(SPEC);
		const lines = Array.from({ length: 60 }, (_, index) => String(index));
		await finishAsync(setup, lines.join("\n"));

		await expect(outcome).resolves.toMatchObject({ outputTail: lines.slice(10) });
	});

	it.for([
		[9, "SIGKILL"],
		[999, null],
	] as const)("should name signal %d as %s", async ([signal, name]) => {
		expect.assertions(1);

		const setup = await setupAsync();
		const outcome = setup.runner(SPEC);
		await finishAsync(setup, "", { exitCode: null, signal });

		await expect(outcome).resolves.toMatchObject({ exitCode: null, signal: name });
	});

	it("should give each run its own worker id", async () => {
		expect.assertions(2);

		const setup = await setupAsync();
		const first = setup.runner(SPEC);
		await finishAsync(setup, "");
		await first;
		const second = setup.runner(SPEC);
		await finishAsync(setup, "");
		await second;

		expect(setup.fake.spawned.map(({ id }) => id)).toStrictEqual(["start-1", "start-2"]);
		expect(setup.fake.spawned[0]).not.toHaveProperty("verbatimArguments");
	});

	it("should stop the whole tree at once when the run outlives its timeout", async () => {
		expect.assertions(2);

		const setup = await setupAsync();
		const outcome = setup.runner({ ...SPEC, timeoutMs: 500 });
		await flushAsync();
		setup.clock.advance(500);
		await flushAsync();

		expect(setup.fake.calls).toStrictEqual(["spawn start-1", "stop start-1 0"]);

		setup.fake.exit("start-1", { ...OK, exitCode: null, forced: true });

		await expect(outcome).resolves.toStrictEqual({
			durationMs: 500,
			outputTail: [],
			type: "timed_out",
		});
	});

	it("should clear the timer when the run ends first", async () => {
		expect.assertions(2);

		const setup = await setupAsync();
		const outcome = setup.runner({ ...SPEC, timeoutMs: 500 });
		await finishAsync(setup, "");

		await expect(outcome).resolves.toMatchObject({ type: "exited" });
		expect([setup.clock.pending(), setup.fake.calls]).toStrictEqual([0, ["spawn start-1"]]);
	});

	it("should report spawn_failed when the reaper rejects the run", async () => {
		expect.assertions(1);

		const error = new ForgeError("process_failed", "The reaper did not start start-1: nope");
		const setup = await setupAsync({ spawnError: error });

		await expect(setup.runner(SPEC)).resolves.toStrictEqual({
			errorCode: undefined,
			message: "The reaper did not start start-1: nope",
			type: "spawn_failed",
		});
	});

	it("should pass on any other spawn error", async () => {
		expect.assertions(1);

		const error = new ForgeError("reaper_unavailable", "gone");
		const setup = await setupAsync({ spawnError: error });

		await expect(setup.runner(SPEC)).rejects.toBe(error);
	});

	it("should start nothing once the session is stopping", async () => {
		expect.assertions(2);

		const setup = await setupAsync();
		setup.abort.abort();

		await expect(setup.runner(SPEC)).resolves.toStrictEqual({
			errorCode: undefined,
			message: "The session is stopping, so start-1 did not start.",
			type: "spawn_failed",
		});
		expect(setup.fake.spawned).toStrictEqual([]);
	});
});
