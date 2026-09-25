import { describe, expect, it, vi } from "vitest";

import { captureOutput } from "../../test/helpers/output.ts";
import type { CapturedOutput } from "../../test/helpers/output.ts";
import { createMemoryFileSystem, createTestSeams, PROJECT } from "../../test/helpers/seams.ts";
import type { CommandContext, CommandInput, CommandRun } from "../commands/context.ts";
import { ForgeError } from "../errors.ts";
import { EXIT_FAILURE, EXIT_NEEDS_CONFIRMATION, EXIT_SUCCESS, EXIT_USAGE } from "../exit-codes.ts";
import type { ConfigLoader } from "../seams/config-loader.ts";
import type { Environment, Seams } from "../seams/seams.ts";
import type { CommandDefinition } from "./commands.ts";
import { COMMANDS } from "./commands.ts";
import type { FlagDefinition } from "./flags.ts";
import { renderCommandHelp, renderHelp } from "./help.ts";
import type { CliContext } from "./run-cli.ts";
import { runCliAsync } from "./run-cli.ts";

interface CliOptions {
	commands?: ReadonlyArray<CommandDefinition>;
	environment?: Environment;
	seams?: Seams;
	/** Both stdin and stdout are terminals. Off by default, as for agents. */
	tty?: boolean;
}

interface Cli {
	captured: CapturedOutput;
	run: (...argv: Array<string>) => ReturnType<typeof runCliAsync>;
}

interface RecordingProbe {
	command: CommandDefinition;
	runs: Array<{ context: CommandContext; input: CommandInput }>;
}

function makeCli({
	commands = COMMANDS,
	environment = {},
	seams = createTestSeams(),
	tty = false,
}: CliOptions = {}): Cli {
	const captured = captureOutput();
	const context: CliContext = {
		commands,
		cwd: PROJECT,
		env: environment,
		output: captured.output,
		seams,
		terminal: { stdinIsTty: tty, stdoutIsTty: tty },
		version: "1.2.3",
	};

	return { captured, run: async (...argv) => runCliAsync(argv, context) };
}

/**
 * A command named `probe` that runs `run`.
 *
 * @param run - What the command does.
 * @param flags - Its flag table.
 * @returns The command.
 */
function probe(run: CommandRun, flags: CommandDefinition["flags"] = []): CommandDefinition {
	return { name: "probe", flags, run, summary: "Probe." };
}

/**
 * A probe that records the context and input of each run.
 *
 * @param flags - Its flag table.
 * @returns The command and its runs so far.
 */
function recordingProbe(flags: CommandDefinition["flags"] = []): RecordingProbe {
	const runs: RecordingProbe["runs"] = [];
	const command = probe(async (context, input) => {
		runs.push({ context, input });
		return { data: {}, summary: "" };
	}, flags);

	return { command, runs };
}

const portFlag: FlagDefinition = {
	name: "port",
	config: "rojoPort",
	kind: "number",
	text: "t",
	value: "<n>",
};

describe(runCliAsync, () => {
	describe("pages", () => {
		it.for(["--version", "-v"])("should print the version for %s", async (flag) => {
			expect.assertions(2);

			const cli = makeCli();

			await expect(cli.run(flag)).resolves.toBe(EXIT_SUCCESS);
			expect(cli.captured.stdout()).toBe("1.2.3\n");
		});

		it.for([[], ["--help"], ["-h"]])("should print the help page for %o", async (argv) => {
			expect.assertions(2);

			const cli = makeCli();

			await expect(cli.run(...argv)).resolves.toBe(EXIT_SUCCESS);
			expect(cli.captured.stdout()).toBe(renderHelp(COMMANDS));
		});

		it("should print a command's help page", async () => {
			expect.assertions(2);

			const cli = makeCli();
			const [init] = COMMANDS;

			await expect(cli.run("init", "--help")).resolves.toBe(EXIT_SUCCESS);
			expect(cli.captured.stdout()).toBe(renderCommandHelp(init!));
		});

		it("should print help, not run the command, when --help is beside a command", async () => {
			expect.assertions(1);

			const { command, runs } = recordingProbe();
			await makeCli({ commands: [command] }).run("probe", "--help");

			expect(runs).toBeEmpty();
		});
	});

	describe("usage errors", () => {
		it.for([
			{ argv: ["--nope"], command: null, message: "Unknown option '--nope'" },
			{ argv: ["serve"], command: null, message: 'Unknown command "serve".' },
			{ argv: ["init", "extra"], command: "init", message: 'Unexpected argument "extra".' },
			{ argv: ["init", "--type"], command: "init", message: "argument missing" },
		])("should exit with the usage code for $argv", async ({ argv, command, message }) => {
			expect.assertions(4);

			const cli = makeCli();

			await expect(cli.run(...argv)).resolves.toBe(EXIT_USAGE);

			const result = cli.captured.result();

			expect(result).toMatchObject({ command, exitCode: EXIT_USAGE, ok: false });
			expect(result.error!.message).toContain(message);
			expect(result.error!.hint).toBe('Run "forge --help" for usage.');
		});

		it("should write usage errors to stderr at a terminal", async () => {
			expect.assertions(2);

			const cli = makeCli({ tty: true });
			await cli.run("serve");

			expect(cli.captured.stdout()).toBe("");
			expect(cli.captured.stderr()).toBe(
				'forge: Unknown command "serve". [usage]\nhint: Run "forge --help" for usage.\n',
			);
		});

		it("should report a bad flag value as usage, naming the flag", async () => {
			expect.assertions(3);

			const { command, runs } = recordingProbe([portFlag]);
			const cli = makeCli({ commands: [command] });

			await expect(cli.run("probe", "--port", "http")).resolves.toBe(EXIT_USAGE);
			expect(cli.captured.result().error!.message).toBe(
				"--port: rojoPort must be a number (was a string)",
			);
			expect(runs).toBeEmpty();
		});
	});

	describe("output format", () => {
		it("should write NDJSON when stdout is not a terminal", async () => {
			expect.assertions(1);

			const cli = makeCli({
				commands: [probe(async () => ({ data: { a: 1 }, summary: "" }))],
			});
			await cli.run("probe");

			expect(cli.captured.jsonLines()).toStrictEqual([
				{ command: "probe", data: { a: 1 }, ok: true, type: "result" },
			]);
		});

		it("should write NDJSON for --json at a terminal", async () => {
			expect.assertions(1);

			const cli = makeCli({
				commands: [probe(async () => ({ data: { a: 1 }, summary: "" }))],
				tty: true,
			});
			await cli.run("probe", "--json");

			expect(cli.captured.jsonLines()).toStrictEqual([
				{ command: "probe", data: { a: 1 }, ok: true, type: "result" },
			]);
		});

		it("should write the command's summary at a terminal", async () => {
			expect.assertions(2);

			const command = probe(async () => ({ data: {}, summary: "All done." }));
			const cli = makeCli({ commands: [command], tty: true });

			await expect(cli.run("probe")).resolves.toBe(EXIT_SUCCESS);
			expect(cli.captured.stdout()).toBe("All done.\n");
		});
	});

	describe("prompting", () => {
		it("should let a command prompt when stdin and stdout are terminals", async () => {
			expect.assertions(1);

			const { command, runs } = recordingProbe();
			await makeCli({ commands: [command], tty: true }).run("probe");

			expect(runs.map(({ context }) => context.interactive)).toStrictEqual([true]);
		});

		it.for([
			{ name: "--json", argv: ["--json"], environment: {} },
			{ name: "CI=true", argv: [], environment: { CI: "true" } },
			{ name: "CI=1", argv: [], environment: { CI: "1" } },
		])("should not let a command prompt with $name", async ({ argv, environment }) => {
			expect.assertions(1);

			const { command, runs } = recordingProbe();
			await makeCli({ commands: [command], environment, tty: true }).run("probe", ...argv);

			expect(runs.map(({ context }) => context.interactive)).toStrictEqual([false]);
		});

		it.for(["", "0", "false"])("should still prompt with CI=%s", async (ci) => {
			expect.assertions(1);

			const { command, runs } = recordingProbe();
			await makeCli({ commands: [command], environment: { CI: ci }, tty: true }).run("probe");

			expect(runs.map(({ context }) => context.interactive)).toStrictEqual([true]);
		});

		it("should not let a command prompt when stdout is not a terminal", async () => {
			expect.assertions(1);

			const { command, runs } = recordingProbe();
			await makeCli({ commands: [command] }).run("probe");

			expect(runs.map(({ context }) => context.interactive)).toStrictEqual([false]);
		});

		it("should exit with needs_confirmation when init would replace a file unasked", async () => {
			expect.assertions(2);

			const { fileSystem } = createMemoryFileSystem({ "rbx-forge.config.ts": "old" });
			const cli = makeCli({ seams: createTestSeams({ fileSystem }) });

			await expect(cli.run("init", "--type", "rbxts")).resolves.toBe(EXIT_NEEDS_CONFIRMATION);
			expect(cli.captured.result()).toMatchObject({
				error: { code: "needs_confirmation" },
				exitCode: EXIT_NEEDS_CONFIRMATION,
			});
		});
	});

	describe("commands", () => {
		it("should hand the command its context and the config values of passed flags", async () => {
			expect.assertions(3);

			const { command, runs } = recordingProbe([
				portFlag,
				{ name: "dry", kind: "boolean", text: "t" },
			]);
			const environment = { HOME: "/home" };
			await makeCli({ commands: [command], environment }).run(
				"probe",
				"--port",
				"4000",
				"--dry",
			);

			const [run] = runs;

			expect(run!.context).toMatchObject({ cwd: PROJECT, env: environment });
			expect(run!.input.config).toStrictEqual({ rojoPort: 4000 });
			expect({ ...run!.input.flags }).toStrictEqual({ dry: true, port: "4000" });
		});

		it("should report a config error with its code and exit code", async () => {
			expect.assertions(2);

			const configLoader = vi.fn<ConfigLoader>().mockResolvedValue({
				path: "/p/rbx-forge.config.ts",
				value: { projectType: "rbxts", x: 1 },
			});
			const cli = makeCli({ seams: createTestSeams({ configLoader }) });

			await expect(cli.run("config")).resolves.toBe(EXIT_FAILURE);
			expect(cli.captured.jsonLines()).toStrictEqual([
				{
					command: "config",
					error: {
						code: "config_invalid",
						hint: "Fix or remove the keys named above.",
						message: "Invalid config in /p/rbx-forge.config.ts:\nx must be removed",
					},
					exitCode: EXIT_FAILURE,
					ok: false,
					type: "result",
				},
			]);
		});

		it("should pass on a ForgeError's own exit code", async () => {
			expect.assertions(1);

			const command = probe(async () => {
				throw new ForgeError("needs_confirmation", "Sure?");
			});

			await expect(makeCli({ commands: [command] }).run("probe")).resolves.toBe(
				EXIT_NEEDS_CONFIRMATION,
			);
		});

		it.for([
			{ name: "an Error", thrown: new Error("boom") },
			{ name: "a string", thrown: "boom" },
		])("should report $name thrown by a command as internal_error", async ({ thrown }) => {
			expect.assertions(2);

			const command = probe(async () => {
				// oxlint-disable-next-line typescript/only-throw-error -- A non-Error throw is the case under test.
				throw thrown;
			});
			const cli = makeCli({ commands: [command] });

			await expect(cli.run("probe")).resolves.toBe(EXIT_FAILURE);
			expect(cli.captured.result().error).toStrictEqual({
				code: "internal_error",
				hint: "This is a bug in forge. Please report it.",
				message: "boom",
			});
		});
	});
});
