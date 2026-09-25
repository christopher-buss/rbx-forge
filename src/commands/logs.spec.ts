import path from "node:path";
import { describe, expect, it } from "vitest";

import { createFakeSignals } from "../../test/helpers/fake-reaper.ts";
import { createManualClock } from "../../test/helpers/manual-clock.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createRecordingReporter,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import { FOLLOW_POLL_MS, runLogsAsync } from "./logs.ts";

const ROJO_LOG = path.join(PROJECT, ".forge", "logs", "rojo.log");

function makeRun(files: Record<string, string> = {}) {
	const memory = createMemoryFileSystem(files);
	const clock = createManualClock();
	const signals = createFakeSignals();
	const reporter = createRecordingReporter();
	const context = createCommandContext({
		reporter,
		seams: createTestSeams({
			clock: clock.clock,
			fileSystem: memory.fileSystem,
			signals: signals.signals,
		}),
	});
	return { clock, context, memory, reporter, signals };
}

async function flushAsync(): Promise<void> {
	await new Promise((resolve) => {
		setImmediate(resolve);
	});
}

describe(runLogsAsync, () => {
	it("should print every line of the log as a log event", async () => {
		expect.assertions(2);

		const { context, reporter } = makeRun({ ".forge/logs/rojo.log": "one\r\ntwo\n" });

		await expect(
			runLogsAsync(context, { argument: "rojo", config: {}, flags: {} }),
		).resolves.toStrictEqual({
			data: { file: ROJO_LOG, lines: 2, service: "rojo" },
			summary: `2 lines of ${ROJO_LOG}.`,
		});
		expect(reporter.events).toStrictEqual([
			{ line: "one", service: "rojo", type: "log" },
			{ line: "two", service: "rojo", type: "log" },
		]);
	});

	it("should say so when the log has no lines yet", async () => {
		expect.assertions(1);

		const { context } = makeRun({ ".forge/logs/compiler.log": "half a line" });

		await expect(
			runLogsAsync(context, { argument: "compiler", config: {}, flags: {} }),
		).resolves.toMatchObject({
			data: { lines: 0 },
			summary: `${path.join(PROJECT, ".forge", "logs", "compiler.log")} has no lines yet.`,
		});
	});

	it.for([
		["no name", {}, "Name the log to read."],
		["an unknown name", { argument: "rojo2" }, 'There is no log named "rojo2".'],
	] as const)("should fail with usage on %s", async ([, named, message]) => {
		expect.assertions(1);

		const { context } = makeRun();

		await expect(
			runLogsAsync(context, {
				...named,
				config: {},
				flags: {},
			}),
		).rejects.toMatchObject({
			code: "usage",
			hint: "Name one of: compile, compiler, rojo, start, supervisor, syncback.",
			message,
		});
	});

	it("should follow new lines, a split line, and a rotation until a stop signal", async () => {
		expect.assertions(3);

		const { clock, context, memory, reporter, signals } = makeRun({
			".forge/logs/rojo.log": "one\n",
		});
		const run = runLogsAsync(context, {
			argument: "rojo",
			config: {},
			flags: { follow: true },
		});
		await flushAsync();
		memory.fileSystem.writeFileSync(ROJO_LOG, ["two", "thr"].join("\n"), { flag: "a" });
		clock.advance(FOLLOW_POLL_MS);
		await flushAsync();
		memory.fileSystem.writeFileSync(ROJO_LOG, "ee\n", { flag: "a" });
		clock.advance(FOLLOW_POLL_MS);
		await flushAsync();
		memory.fileSystem.writeFileSync(ROJO_LOG, "new\n");
		clock.advance(FOLLOW_POLL_MS);
		await flushAsync();
		memory.fileSystem.rmSync(ROJO_LOG);
		clock.advance(FOLLOW_POLL_MS);
		await flushAsync();
		signals.fire("SIGINT");

		await expect(run).resolves.toMatchObject({ data: { lines: 4 } });
		expect(reporter.events).toStrictEqual(
			["one", "two", "three", "new"].map((line) => {
				return { line, service: "rojo", type: "log" };
			}),
		);
		expect(signals.listeners()).toBe(0);
	});

	it("should stop following at once on a stop signal", async () => {
		expect.assertions(1);

		const { context, signals } = makeRun();
		const run = runLogsAsync(context, {
			argument: "start",
			config: {},
			flags: { follow: true },
		});
		await flushAsync();
		signals.fire("SIGTERM");

		await expect(run).resolves.toMatchObject({ data: { lines: 0, service: "start" } });
	});
});
