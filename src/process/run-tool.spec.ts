import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
	createCommandContext,
	createMemoryFileSystem,
	createRecordingReporter,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import type { RecordingReporter } from "../../test/helpers/seams.ts";
import type { CommandContext } from "../commands/context.ts";
import type { ForgeError } from "../errors.ts";
import type { ProcessOutcome, ProcessRunner } from "./process-runner.ts";
import type { ToolCall } from "./run-tool.ts";
import { runToolAsync } from "./run-tool.ts";

const TOOLS = path.join(PROJECT, "tools");
const INSTALLED: Record<string, string> = { "tools/rbxtsc": "" };

const CALL: ToolCall = {
	args: ["-p", "."],
	command: "rbxtsc",
	label: "The compiler",
	missing: "compiler_missing",
	missingHint: "Install roblox-ts.",
	step: "rbxtsc",
};

interface ToolRun {
	context: CommandContext;
	processRunner: ReturnType<typeof vi.fn<ProcessRunner>>;
	reporter: RecordingReporter;
}

function makeToolRun(outcome: ProcessOutcome, files = INSTALLED): ToolRun {
	const reporter = createRecordingReporter();
	const processRunner = vi.fn<ProcessRunner>().mockResolvedValue(outcome);

	return {
		context: createCommandContext({
			env: { PATH: TOOLS },
			reporter,
			seams: createTestSeams({
				fileSystem: createMemoryFileSystem(files).fileSystem,
				processRunner,
			}),
		}),
		processRunner,
		reporter,
	};
}

function exited(exitCode: null | number, outputTail: Array<string> = []): ProcessOutcome {
	return { durationMs: 900, exitCode, outputTail, signal: null, type: "exited" };
}

describe(runToolAsync, () => {
	it("should run the resolved tool in the project with the run's environment", async () => {
		expect.assertions(2);

		const { context, processRunner } = makeToolRun(exited(0, ["done"]));

		await expect(runToolAsync(context, CALL)).resolves.toStrictEqual({
			durationMs: 900,
			outputTail: ["done"],
		});
		expect(processRunner).toHaveBeenCalledExactlyOnceWith({
			args: ["-p", "."],
			cwd: PROJECT,
			env: { PATH: TOOLS },
			file: path.join(TOOLS, "rbxtsc"),
		});
	});

	it("should report the run as a step", async () => {
		expect.assertions(1);

		const { context, reporter } = makeToolRun(exited(0));
		await runToolAsync(context, CALL);

		expect(reporter.events).toStrictEqual([
			{ name: "rbxtsc", status: "started", type: "step" },
			{ name: "rbxtsc", status: "succeeded", type: "step" },
		]);
	});

	it("should fail with the missing code when the tool is not installed", async () => {
		expect.assertions(2);

		const { context, processRunner } = makeToolRun(exited(0), {});

		await expect(runToolAsync(context, CALL)).rejects.toMatchObject({
			code: "compiler_missing",
			hint: "Install roblox-ts.",
			message:
				'The compiler ("rbxtsc") is not installed: it is not a bin of a project dependency or on PATH.',
		} satisfies Partial<ForgeError>);
		expect(processRunner).not.toHaveBeenCalled();
	});

	it("should fail with the missing code when the file vanished before the spawn", async () => {
		expect.assertions(1);

		const { context } = makeToolRun({
			errorCode: "ENOENT",
			message: "spawn rbxtsc ENOENT",
			type: "spawn_failed",
		});

		await expect(runToolAsync(context, CALL)).rejects.toMatchObject({
			code: "compiler_missing",
		});
	});

	it("should fail as process_failed when the tool cannot start for another reason", async () => {
		expect.assertions(1);

		const { context } = makeToolRun({
			errorCode: "EACCES",
			message: "spawn rbxtsc EACCES",
			type: "spawn_failed",
		});

		await expect(runToolAsync(context, CALL)).rejects.toMatchObject({
			code: "process_failed",
			message: "The compiler could not start: spawn rbxtsc EACCES",
		});
	});

	it("should fail with the exit code and the last output lines", async () => {
		expect.assertions(2);

		const output = Array.from({ length: 25 }, (_, index) => `line ${index}`);
		const { context, reporter } = makeToolRun(exited(2, output));

		await expect(runToolAsync(context, CALL)).rejects.toMatchObject({
			code: "process_failed",
			details: { outputTail: output },
			message: [
				"rbxtsc failed (exit code 2).",
				...output.slice(5).map((line) => `  ${line}`),
			].join("\n"),
		});
		expect(reporter.events.at(-1)).toStrictEqual({
			name: "rbxtsc",
			status: "failed",
			type: "step",
		});
	});

	it("should fail a tool that a signal ended", async () => {
		expect.assertions(1);

		const { context } = makeToolRun(exited(null));

		await expect(runToolAsync(context, CALL)).rejects.toMatchObject({
			message: "rbxtsc failed (exit code null).",
		});
	});

	it("should fail a tool that timed out", async () => {
		expect.assertions(1);

		const { context } = makeToolRun({ durationMs: 10, outputTail: [], type: "timed_out" });

		await expect(runToolAsync(context, CALL)).rejects.toMatchObject({
			message: "rbxtsc failed (timed out and was killed).",
		});
	});
});
