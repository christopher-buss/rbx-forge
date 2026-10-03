import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { SCRIPTS } from "../../src/studio/rojo-plugin.ts";

describe("shipped Rojo plugin Lua", () => {
	it("should enforce launch identity, reconnect safely, and scope readiness to the original session", () => {
		expect.assertions(1);

		const directory = mkdtempSync(path.join(os.tmpdir(), "forge-plugin-lua-"));
		onTestFinished(() => {
			rmSync(directory, { force: true, recursive: true });
		});
		let harness = readFileSync(
			path.join(import.meta.dirname, "../fixtures/rojo-plugin-harness.luau"),
			"utf8",
		);
		const placeholders: Record<string, string> = {
			App: "__APP_SOURCE__",
			ServeSession: "__SESSION_SOURCE__",
		};
		for (const { name, source } of SCRIPTS) {
			harness = harness.replace(placeholders[name]!, () => source);
		}

		const file = path.join(directory, "plugin.luau");
		writeFileSync(file, harness);

		expect(execFileSync("luau", [file], { encoding: "utf8", windowsHide: true })).toContain(
			"PASS: full shipped App/ServeSession",
		);
	});
});
