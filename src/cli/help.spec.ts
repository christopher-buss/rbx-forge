import { describe, expect, it } from "vitest";

import { EXIT_CODE_HELP } from "../exit-codes.ts";
import { COMMANDS } from "./commands.ts";
import type { CommandDefinition } from "./commands.ts";
import { GLOBAL_FLAGS } from "./flags.ts";
import { renderCommandHelp, renderHelp } from "./help.ts";

const ALL_FLAGS = [...GLOBAL_FLAGS, ...COMMANDS.flatMap(({ flags }) => flags)];

const GLOBAL_PAGE_LINES = renderHelp(COMMANDS).split("\n");
const COMMAND_FLAGS = COMMANDS.flatMap((command) => {
	return [...command.flags, ...GLOBAL_FLAGS].map((flag) => ({ command, flag }));
});

describe(renderHelp, () => {
	it.for(COMMANDS)("should list the $name command with its summary", ({ name, summary }) => {
		expect.assertions(1);

		expect(GLOBAL_PAGE_LINES).toContain(`  ${name.padEnd(6)}  ${summary}`);
	});

	it.for(GLOBAL_FLAGS)("should list the global flag --$name", ({ name }) => {
		expect.assertions(1);

		expect(GLOBAL_PAGE_LINES.some((line) => line.includes(`--${name}`))).toBeTrue();
	});

	it.for(EXIT_CODE_HELP)("should list exit code %i", ([code, text]) => {
		expect.assertions(1);

		expect(GLOBAL_PAGE_LINES).toContain(`  ${String(code).padEnd(3)}  ${text}`);
	});

	it("should lay out the page with aligned columns", () => {
		expect.assertions(1);

		const commands: ReadonlyArray<CommandDefinition> = [
			{
				name: "a",
				flags: [],
				run: async () => ({ data: {}, summary: "" }),
				summary: "First.",
			},
			{
				name: "bbb",
				flags: [],
				run: async () => ({ data: {}, summary: "" }),
				summary: "Second.",
			},
		];

		expect(renderHelp(commands)).toStartWith(
			[
				"forge - supervised Rojo and roblox-ts sessions.",
				"",
				"Usage",
				"  forge <command> [options]",
				"",
				"Commands",
				"  a    First.",
				"  bbb  Second.",
				"",
				"Options",
				"  -h, --help     Show help and exit.",
				"  -v, --version  Print the version and exit.",
				"  --json         Write NDJSON events and a final result object (the default when stdout is not a terminal).",
				"",
				"Exit codes",
				"  0    success",
			].join("\n"),
		);
	});

	it("should end by pointing at the command pages", () => {
		expect.assertions(1);

		expect(renderHelp(COMMANDS)).toEndWith(
			'\n\nRun "forge <command> --help" for the options of a command.\n',
		);
	});
});

describe(renderCommandHelp, () => {
	it.for(COMMAND_FLAGS)(
		"should list --$flag.name on the $command.name page",
		({ command, flag }) => {
			expect.assertions(1);

			expect(renderCommandHelp(command)).toContain(`--${flag.name}`);
		},
	);

	it("should show value placeholders, config overrides, and repeatable flags", () => {
		expect.assertions(1);

		const page = renderCommandHelp({
			name: "demo",
			flags: [
				{
					name: "port",
					config: "rojoPort",
					kind: "number",
					text: "Port.",
					value: "<port>",
				},
				{ name: "include", kind: "list", short: "i", text: "Glob.", value: "<glob>" },
			],
			run: async () => ({ data: {}, summary: "" }),
			summary: "Demo.",
		});

		expect(page).toBe(
			[
				"forge demo - Demo.",
				"",
				"Usage",
				"  forge demo [options]",
				"",
				"Options",
				"  --port <port>         Port. (overrides config: rojoPort)",
				"  -i, --include <glob>  Glob. [repeatable]",
				"",
				"Global options",
				"  -h, --help     Show help and exit.",
				"  -v, --version  Print the version and exit.",
				"  --json         Write NDJSON events and a final result object (the default when stdout is not a terminal).",
				"",
			].join("\n"),
		);
	});

	it("should leave out the options block for a command without flags", () => {
		expect.assertions(1);

		const page = renderCommandHelp({
			name: "demo",
			flags: [],
			run: async () => ({ data: {}, summary: "" }),
			summary: "Demo.",
		});

		expect(page).not.toContain("\nOptions\n");
	});
});

describe("flag tables", () => {
	it.for(ALL_FLAGS)(
		"should give --$name a value placeholder only when it takes a value",
		(flag) => {
			expect.assertions(1);

			expect(flag.value === undefined).toBe(flag.kind === "boolean");
		},
	);

	it.for(COMMANDS)("should use each flag name once on $name", ({ flags }) => {
		expect.assertions(1);

		const names = [...GLOBAL_FLAGS, ...flags].map(({ name }) => name);
		const unique = new Set(names);

		expect(unique.size).toBe(names.length);
	});
});
