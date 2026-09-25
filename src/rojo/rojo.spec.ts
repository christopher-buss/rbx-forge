import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { catchForgeError } from "../../test/helpers/errors.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import type { CommandContext } from "../commands/context.ts";
import type { ForgeError } from "../errors.ts";
import type { ProcessOutcome, ProcessRunner } from "../process/process-runner.ts";
import {
	requireSyncbackAsync,
	rojoBuildArgs,
	rojoInvocation,
	rojoServeArgs,
	rojoSyncbackArgs,
} from "./rojo.ts";

const TOOLS = path.join(PROJECT, "tools");

interface ProbeRun {
	context: CommandContext;
	processRunner: ReturnType<typeof vi.fn<ProcessRunner>>;
}

const INSTALLED: Record<string, string> = { "tools/rojo-fork": "" };

function makeProbe(outcome: ProcessOutcome, files = INSTALLED): ProbeRun {
	const processRunner = vi.fn<ProcessRunner>().mockResolvedValue(outcome);

	return {
		context: createCommandContext({
			env: { PATH: TOOLS },
			seams: createTestSeams({
				fileSystem: createMemoryFileSystem(files).fileSystem,
				processRunner,
			}),
		}),
		processRunner,
	};
}

function exited(exitCode: number): ProcessOutcome {
	return { durationMs: 5, exitCode, outputTail: [], signal: null, type: "exited" };
}

describe(rojoBuildArgs, () => {
	it("should build the project to an output file", () => {
		expect.assertions(1);

		expect(
			rojoBuildArgs("default.project.json", { output: "out/game.rbxl", type: "output" }),
		).toStrictEqual(["build", "default.project.json", "--output", "out/game.rbxl"]);
	});

	it("should build the project into the plugins folder", () => {
		expect.assertions(1);

		expect(
			rojoBuildArgs("plugin.project.json", { plugin: "Tool.rbxm", type: "plugin" }),
		).toStrictEqual(["build", "plugin.project.json", "--plugin", "Tool.rbxm"]);
	});
});

describe(rojoSyncbackArgs, () => {
	it("should sync the place back into the project without a prompt", () => {
		expect.assertions(1);

		expect(rojoSyncbackArgs("sync.project.json", "out/game.rbxl")).toStrictEqual([
			"syncback",
			"sync.project.json",
			"--input",
			"out/game.rbxl",
			"--non-interactive",
		]);
	});
});

describe(requireSyncbackAsync, () => {
	it("should ask the configured Rojo for its syncback help", async () => {
		expect.assertions(2);

		const { context, processRunner } = makeProbe(exited(0));

		await expect(
			requireSyncbackAsync(context, { rojoAlias: "rojo-fork" }),
		).resolves.toBeUndefined();
		expect(processRunner).toHaveBeenCalledExactlyOnceWith({
			args: ["syncback", "--help"],
			cwd: PROJECT,
			env: { PATH: TOOLS },
			file: path.join(TOOLS, "rojo-fork"),
		});
	});

	it("should fail with syncback_unsupported naming the fork when Rojo has no syncback", async () => {
		expect.assertions(1);

		const { context } = makeProbe(exited(2));

		await expect(
			requireSyncbackAsync(context, { rojoAlias: "rojo-fork" }),
		).rejects.toMatchObject({
			code: "syncback_unsupported",
			hint: "Install the UpliftGames Rojo fork (https://github.com/UpliftGames/rojo/releases), and set rojoAlias to its command if it is not rojo.",
			message:
				'Rojo ("rojo-fork") has no syncback command. Syncback needs the UpliftGames Rojo fork.',
		} satisfies Partial<ForgeError>);
	});

	it("should fail as process_failed naming Rojo when it cannot start", async () => {
		expect.assertions(1);

		const { context } = makeProbe({
			errorCode: "EACCES",
			message: "spawn rojo-fork EACCES",
			type: "spawn_failed",
		});

		await expect(
			requireSyncbackAsync(context, { rojoAlias: "rojo-fork" }),
		).rejects.toMatchObject({
			code: "process_failed",
			message: "Rojo could not start: spawn rojo-fork EACCES",
		});
	});

	it("should fail with rojo_missing when Rojo is not installed", async () => {
		expect.assertions(1);

		const { context } = makeProbe(exited(0), {});

		await expect(requireSyncbackAsync(context, { rojoAlias: "rojo" })).rejects.toMatchObject({
			code: "rojo_missing",
		});
	});
});

describe(rojoServeArgs, () => {
	it("should serve the project on the given port", () => {
		expect.assertions(1);

		expect(rojoServeArgs("default.project.json", 34_872)).toStrictEqual([
			"serve",
			"default.project.json",
			"--port",
			"34872",
		]);
	});
});

describe(rojoInvocation, () => {
	it("should start the configured Rojo command found on PATH", () => {
		expect.assertions(1);

		const { context } = makeProbe(exited(0));

		expect(
			rojoInvocation(context, { rojoAlias: "rojo-fork" }, ["serve", "default.project.json"]),
		).toStrictEqual({
			args: ["serve", "default.project.json"],
			file: path.join(TOOLS, "rojo-fork"),
		});
	});

	it("should fail with rojo_missing when the command is not installed", () => {
		expect.assertions(2);

		const { context } = makeProbe(exited(0), {});
		const error = catchForgeError(() => {
			rojoInvocation(context, { rojoAlias: "rojo" }, ["serve"]);
		});

		expect(error.code).toBe("rojo_missing");
		expect(error.hint).toBe(
			"Install Rojo (https://rojo.space), for example with rokit or mise, or set rojoAlias to its command.",
		);
	});
});
