import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, vi } from "vitest";

import { stock } from "../../test/helpers/rojo-stock.ts";
import { loadLuaText, luaTextPlugin } from "./lua-text.ts";

const APP = path.join(import.meta.dirname, "..", "studio", "rojo-plugin", "stock", "App.lua");
const APP_MODULE = `export default ${JSON.stringify(stock.App)};`;

describe(loadLuaText, () => {
	it("should load a .lua file as a module of its text", ({ expect }) => {
		expect.assertions(1);

		const next = vi.fn<Parameters<typeof loadLuaText>[2]>();

		expect(
			loadLuaText(
				pathToFileURL(APP).href,
				{ conditions: [], format: undefined, importAttributes: {} },
				next,
			),
		).toStrictEqual({
			format: "module",
			shortCircuit: true,
			source: APP_MODULE,
		});
	});

	it.for(["file:///project/src/index.ts", "node:fs"])("should pass %s on", (url, { expect }) => {
		expect.assertions(1);

		const context = { conditions: [], format: undefined, importAttributes: {} };
		const next = vi.fn<Parameters<typeof loadLuaText>[2]>(() => {
			return {
				format: "module",
				source: "",
			};
		});
		loadLuaText(url, context, next);

		expect(next).toHaveBeenCalledExactlyOnceWith(url, context);
	});
});

describe(luaTextPlugin, () => {
	it("should load a .lua file as a module of its text, and nothing else", ({ expect }) => {
		expect.assertions(3);

		const plugin = luaTextPlugin();

		expect(plugin.name).toBe("lua-text");
		expect(plugin.load(APP)).toBe(APP_MODULE);
		expect(plugin.load(path.join(import.meta.dirname, "lua-text.ts"))).toBeUndefined();
	});
});
