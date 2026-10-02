import { copyFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadRealNative } from "../helpers/real-native.ts";
import { makeTemporaryDirectory } from "../helpers/temporary-directory.ts";

const native = loadRealNative();
// Rojo builds this fixture from the adjacent scripts.project.json.
const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "models", "scripts.rbxm");
const APP = ["NativeModelFixture", "App"];
const UNCHANGED = ["NativeModelFixture", "Unchanged"];

function makeModel(): string {
	const model = path.join(makeTemporaryDirectory(), "scripts.rbxm");
	copyFileSync(FIXTURE, model);
	return model;
}

describe("native model script sources", () => {
	it("should read requested sources in order from a Rojo-built binary model", () => {
		expect.assertions(1);

		expect(native.readModelScriptSources(makeModel(), [UNCHANGED, APP])).toStrictEqual([
			'return "untouched script"\n',
			'return "original app"\n',
		]);
	});

	it("should round-trip replacements and keep the other script", () => {
		expect.assertions(3);

		const model = makeModel();
		const original = readFileSync(model);

		native.writeModelScriptSources(model, [{ path: APP, source: 'return "patched app"' }]);

		expect(native.readModelScriptSources(model, [APP, UNCHANGED])).toStrictEqual([
			'return "patched app"',
			'return "untouched script"\n',
		]);

		native.writeModelScriptSources(model, [{ path: APP, source: 'return "original app"\n' }]);

		expect(native.readModelScriptSources(model, [APP])).toStrictEqual([
			'return "original app"\n',
		]);
		expect(readFileSync(model)).toStrictEqual(original);
	});

	it("should report missing script paths and preserve the original on a failed write", () => {
		expect.assertions(3);

		const model = makeModel();
		const original = readFileSync(model);
		const missing = ["NativeModelFixture", "Missing"];

		expect(() => native.readModelScriptSources(model, [missing])).toThrow(/missing instance/u);
		expect(() => {
			native.writeModelScriptSources(model, [
				{ path: APP, source: "would change" },
				{ path: missing, source: "invalid" },
			]);
		}).toThrow(/missing instance/u);
		expect(readFileSync(model)).toStrictEqual(original);
	});
});
