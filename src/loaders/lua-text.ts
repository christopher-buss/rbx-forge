import { readFileSync } from "node:fs";
import type { LoadFnOutput, LoadHookSync } from "node:module";
import { fileURLToPath } from "node:url";

/** A Rolldown or Vite plugin: the shape tsdown and vitest share. */
interface LuaTextPlugin {
	name: string;
	load: (id: string) => string | undefined;
}

type LoadContext = Parameters<LoadHookSync>[1];
type NextLoad = Parameters<LoadHookSync>[2];

/**
 * The Node load hook, for a process that runs from source.
 *
 * @param url - The module's URL.
 * @param context - Node's load context.
 * @param nextLoad - The hook after this one.
 * @returns A module of the file's text for a `.lua` file; else what
 *   `nextLoad` gives.
 */
export function loadLuaText(url: string, context: LoadContext, nextLoad: NextLoad): LoadFnOutput {
	if (url.endsWith(".lua")) {
		return { format: "module", shortCircuit: true, source: luaTextModule(fileURLToPath(url)) };
	}

	return nextLoad(url, context);
}

/**
 * The same modules for tsdown's bundle and vitest.
 *
 * @returns A plugin that loads each `.lua` file as its text.
 */
export function luaTextPlugin(): LuaTextPlugin {
	return {
		name: "lua-text",
		load: (id) => (id.endsWith(".lua") ? luaTextModule(id) : undefined),
	};
}

/**
 * The module a `.lua` file becomes.
 *
 * @param file - The file's path.
 * @returns A module whose default export is the file's text.
 */
function luaTextModule(file: string): string {
	return `export default ${JSON.stringify(readFileSync(file, "utf8"))};`;
}
