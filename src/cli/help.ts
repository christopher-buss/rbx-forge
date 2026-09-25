import { FLAGS } from "./flags.ts";

const INDENT = "  ";
const GAP = "  ";

/**
 * The `--help` page, generated from the flag table.
 *
 * @returns The full page, ending in a newline.
 */
export function renderHelp(): string {
	const rows = FLAGS.map(({ name, short, text }): [string, string] => {
		return [`-${short}, --${name}`, text];
	});
	const column = Math.max(...rows.map(([label]) => label.length));

	const lines = [
		"forge - supervised Rojo and roblox-ts sessions.",
		"",
		"Usage",
		`${INDENT}forge [options]`,
		"",
		"Options",
		...rows.map(([label, text]) => `${INDENT}${label.padEnd(column)}${GAP}${text}`),
	];

	return `${lines.join("\n")}\n`;
}
