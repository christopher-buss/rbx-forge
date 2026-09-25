import { EXIT_CODE_HELP } from "../exit-codes.ts";
import type { CommandDefinition } from "./commands.ts";
import type { FlagDefinition } from "./flags.ts";
import { GLOBAL_FLAGS } from "./flags.ts";

type Row = readonly [label: string, text: string];

interface Block {
	rows: ReadonlyArray<Row>;
	title: string;
}

const INDENT = "  ";
const GAP = "  ";
const HEADING = "forge - supervised Rojo and roblox-ts sessions.";

/**
 * The `forge --help` page, generated from the command and flag tables.
 *
 * @param commands - Every command.
 * @returns The page, ending in a newline.
 */
export function renderHelp(commands: ReadonlyArray<CommandDefinition>): string {
	const page = renderPage(HEADING, "forge <command> [options]", [
		{ rows: commands.map(({ name, summary }) => [name, summary]), title: "Commands" },
		{ rows: GLOBAL_FLAGS.map(flagRow), title: "Options" },
		{ rows: EXIT_CODE_HELP.map(([code, text]) => [String(code), text]), title: "Exit codes" },
	]);

	return `${page}\nRun "forge <command> --help" for the options of a command.\n`;
}

/**
 * The `forge <command> --help` page, generated from the command's flag table.
 *
 * @param command - The command whose flags the page lists.
 * @returns The page, ending in a newline.
 */
export function renderCommandHelp(command: CommandDefinition): string {
	const blocks: Array<Block> = [];
	if (command.flags.length > 0) {
		blocks.push({ rows: command.flags.map(flagRow), title: "Options" });
	}

	blocks.push({ rows: GLOBAL_FLAGS.map(flagRow), title: "Global options" });

	return renderPage(
		`forge ${command.name} - ${command.summary}`,
		`forge ${command.name} [options]`,
		blocks,
	);
}

function flagRow({ name, config, kind, short, text, value }: FlagDefinition): Row {
	const names = short === undefined ? `--${name}` : `-${short}, --${name}`;
	const notes = [text];
	if (config !== undefined) {
		notes.push(`(overrides config: ${config})`);
	}

	if (kind === "list") {
		notes.push("[repeatable]");
	}

	return [value === undefined ? names : `${names} ${value}`, notes.join(" ")];
}

function renderPage(heading: string, usage: string, blocks: ReadonlyArray<Block>): string {
	const lines = [heading, "", "Usage", `${INDENT}${usage}`];
	for (const { rows, title } of blocks) {
		const column = Math.max(...rows.map(([label]) => label.length));
		lines.push(
			"",
			title,
			...rows.map(([label, text]) => `${INDENT}${label.padEnd(column)}${GAP}${text}`),
		);
	}

	return `${lines.join("\n")}\n`;
}
