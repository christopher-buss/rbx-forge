import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Keep real Rojo running while an owned fixture cuts Studio's transport.
 * @param project - The disposable fixture project.
 * @param rojo - The pinned genuine executable.
 * @returns The configured alias and its one-way disconnect control.
 */
export function installCaptureRojoProxy(
	project: string,
	rojo: string,
): {
	alias: string;
	disconnect: () => void;
} {
	const alias = "forge-capture-rojo";
	const directory = path.join(project, "node_modules", alias);
	const flag = path.join(project, "capture-disconnected");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		path.join(project, "package.json"),
		JSON.stringify({ devDependencies: { [alias]: "1.0.0" } }),
	);
	writeFileSync(
		path.join(directory, "package.json"),
		JSON.stringify({ name: alias, bin: { [alias]: "cli.mjs" }, type: "module" }),
	);
	const entry = pathToFileURL(
		path.join(import.meta.dirname, "../fixtures/bin/capture-rojo-proxy.ts"),
	);
	writeFileSync(
		path.join(directory, "cli.mjs"),
		[
			`process.env.FORGE_CAPTURE_TEST_ROJO = ${JSON.stringify(rojo)};`,
			`process.env.FORGE_CAPTURE_TEST_DISCONNECT = ${JSON.stringify(flag)};`,
			`await import(${JSON.stringify(entry.href)});`,
		].join("\n"),
	);
	function disconnect(): void {
		writeFileSync(flag, "disconnect");
	}

	return { alias, disconnect };
}
