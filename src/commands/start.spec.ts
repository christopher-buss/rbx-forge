import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createFakeReaper, createFakeSignals } from "../../test/helpers/fake-reaper.ts";
import type { FakeReaper, FakeReaperOptions } from "../../test/helpers/fake-reaper.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createRecordingReporter,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import type { MemoryFileSystem, RecordingReporter } from "../../test/helpers/seams.ts";
import type { WorkerReport } from "../reaper/protocol.ts";
import type { ReaperEnd } from "../reaper/reaper-client.ts";
import type { ConfigLoader } from "../seams/config-loader.ts";
import type { Network } from "../seams/network.ts";
import type { CommandResult } from "../seams/reporter.ts";
import type { CommandInput } from "./context.ts";
import { runStartAsync } from "./start.ts";

const TOOLS = path.join(PROJECT, "tools");
const ROJO_ONLY: CommandInput = { config: {}, flags: { compiler: false, open: false } };
const EXITED: WorkerReport = { exitCode: 3, forced: false, incomplete: false, signal: null };
const LOG = path.join(PROJECT, ".forge", "logs", "rojo.log");

interface StartSetup {
	/** The config file's content besides `projectType`. */
	file?: object;
	files?: Record<string, string>;
	/** Whether the Rojo port is free. */
	isPortFree?: boolean;
	reaper?: FakeReaperOptions;
}

interface StartRun {
	fake: FakeReaper;
	isPortFreeAsync: ReturnType<typeof vi.fn<Network["isPortFreeAsync"]>>;
	memory: MemoryFileSystem;
	reporter: RecordingReporter;
	result: Promise<CommandResult>;
	signals: ReturnType<typeof createFakeSignals>;
}

function startCommand(
	{ file = {}, files = { "tools/rojo": "" }, isPortFree = true, reaper = {} }: StartSetup = {},
	input: CommandInput = ROJO_ONLY,
): StartRun {
	const memory = createMemoryFileSystem(files);
	const fake = createFakeReaper(reaper);
	const signals = createFakeSignals();
	const reporter = createRecordingReporter();
	const isPortFreeAsync = vi.fn<Network["isPortFreeAsync"]>().mockResolvedValue(isPortFree);
	const configLoader = vi.fn<ConfigLoader>().mockResolvedValue({
		path: path.join(PROJECT, "rbx-forge.config.ts"),
		value: { projectType: "luau", rojoPort: 4000, ...file },
	});
	const context = createCommandContext({
		env: { PATH: TOOLS },
		reporter,
		seams: createTestSeams({
			configLoader,
			fileSystem: memory.fileSystem,
			network: { isPortFreeAsync },
			randomId: () => "session-1",
			reaper: fake.launch,
			signals: signals.signals,
		}),
	});

	return {
		fake,
		isPortFreeAsync,
		memory,
		reporter,
		result: runStartAsync(context, input),
		signals,
	};
}

async function flushAsync(): Promise<void> {
	await new Promise((resolve) => {
		setImmediate(resolve);
	});
}

/**
 * Start a session and end it with a stop signal once Rojo runs.
 *
 * @param setup - The session's setup.
 * @returns The run, ended.
 */
async function stoppedAsync(setup: StartSetup = {}): Promise<StartRun> {
	const run = startCommand(setup);
	await flushAsync();
	run.signals.fire("SIGINT");
	return run;
}

async function failedAsync(report: WorkerReport, end?: ReaperEnd): Promise<StartRun> {
	const run = startCommand(end === undefined ? {} : { reaper: { end } });
	await flushAsync();
	run.fake.exit("rojo", report);
	return run;
}

describe(runStartAsync, () => {
	it.for([
		["no flags", {}],
		["only --no-open", { open: false }],
		["only --no-compiler", { compiler: false }],
		["--open --no-compiler", { compiler: false, open: true }],
	] as const)("should fail with usage for %s", async ([, flags]) => {
		expect.assertions(2);

		const { fake, result } = startCommand({}, { config: {}, flags });

		await expect(result).rejects.toMatchObject({
			code: "usage",
			hint: 'Run "forge start --help" for usage.',
			message: "forge start runs only Rojo for now: pass --no-open --no-compiler.",
		});
		expect(fake.launches).toStrictEqual([]);
	});

	it("should serve the Rojo project on the fixed port through the reaper", async () => {
		expect.assertions(3);

		const { fake, isPortFreeAsync, result } = await stoppedAsync();
		await result;

		expect(isPortFreeAsync).toHaveBeenCalledExactlyOnceWith(4000);
		expect(fake.launches).toStrictEqual([
			{
				leasePath: path.join(PROJECT, ".forge", "sessions", "session-1", "workers.lock"),
				sessionId: "session-1",
			},
		]);
		expect(fake.spawned).toStrictEqual([
			{
				id: "rojo",
				args: ["serve", "default.project.json", "--port", "4000"],
				cwd: PROJECT,
				env: { PATH: TOOLS },
				file: path.join(TOOLS, "rojo"),
				log: LOG,
			},
		]);
	});

	it("should report the step and a ready line, then the stop", async () => {
		expect.assertions(2);

		const { reporter, result } = await stoppedAsync();

		await expect(result).resolves.toStrictEqual({
			data: { port: 4000, reason: "SIGINT", reports: [] },
			summary: "Stopped on SIGINT; every process of the session is gone.",
		});
		expect(reporter.events).toStrictEqual([
			{ name: "rojo serve", status: "started", type: "step" },
			{ name: "rojo serve", status: "succeeded", type: "step" },
			{
				message: "Rojo serves default.project.json on port 4000. Press Ctrl+C to stop.",
				type: "info",
			},
		]);
	});

	it("should keep the logs and remove the session directory when the session ends", async () => {
		expect.assertions(2);

		const { memory, result } = await stoppedAsync();
		await result;

		expect(Object.keys(memory.files())).toIncludeAllMembers([".forge/logs"]);
		expect(
			Object.keys(memory.files()).filter((file) => file.includes("sessions/")),
		).toStrictEqual([]);
	});

	it("should fail with port_in_use when the fixed port is busy, starting nothing", async () => {
		expect.assertions(2);

		const { fake, result } = startCommand({ isPortFree: false });

		await expect(result).rejects.toMatchObject({
			code: "port_in_use",
			hint: "Stop the program that uses it, or set rojoPort to a free port.",
			message: "Rojo port 4000 is in use.",
		});
		expect(fake.launches).toStrictEqual([]);
	});

	it("should fail with rojo_missing before it creates any session file", async () => {
		expect.assertions(2);

		const { memory, result } = startCommand({ files: {} });

		await expect(result).rejects.toMatchObject({ code: "rojo_missing" });
		expect(memory.files()).toStrictEqual({});
	});

	it("should fail with service_failed when Rojo exits, naming its log", async () => {
		expect.assertions(1);

		const { result } = await failedAsync(EXITED);

		await expect(result).rejects.toMatchObject({
			code: "service_failed",
			details: { reason: "service_failed:rojo", reports: [] },
			hint: `Its output is in ${LOG}.`,
			message: "rojo exited (exit code 3), so the session stopped.",
		});
	});

	it.for([
		[{ exitCode: null, signal: 9 }, "rojo exited (signal 9), so the session stopped."],
		[{ exitCode: null, signal: null }, "rojo exited (killed), so the session stopped."],
	] as const)("should describe an exit of %o", async ([exit, message]) => {
		expect.assertions(1);

		const { result } = await failedAsync({ ...EXITED, ...exit });

		await expect(result).rejects.toMatchObject({ message });
	});

	it("should fail with cleanup_in_progress when a worker outlived the wait", async () => {
		expect.assertions(2);

		const reports = [
			{ id: "rojo", report: { ...EXITED, incomplete: true } },
			{ id: "hook", report: EXITED },
		];
		const { memory, result } = await failedAsync(EXITED, { reports, terminated: true });

		await expect(result).rejects.toMatchObject({
			code: "cleanup_in_progress",
			details: { reports },
			message: "Processes of rojo were still alive when forge stopped waiting.",
		});
		expect(
			Object.keys(memory.files()).filter((file) => file.includes("sessions/")),
		).toStrictEqual([]);
	});
});
