import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { makeTemporaryDirectory } from "../helpers/temporary-directory.ts";
import { readWorkerLog } from "../helpers/worker-log.ts";

describe("fixture worker log", () => {
	it("should wait for a newline before reading a worker record being appended", () => {
		expect.assertions(2);

		const file = path.join(makeTemporaryDirectory(), "workers.ndjson");
		writeFileSync(file, '{"role":"rojo"}\n{"args"');

		expect(readWorkerLog(file)).toStrictEqual([{ role: "rojo" }]);

		appendFileSync(file, ':[],"role":"rbxtsc"}\n');

		expect(readWorkerLog(file)).toStrictEqual([{ role: "rojo" }, { args: [], role: "rbxtsc" }]);
	});

	it("should reject a malformed completed worker record", () => {
		expect.assertions(1);

		const file = path.join(makeTemporaryDirectory(), "workers.ndjson");
		writeFileSync(file, '{"args"\n');

		expect(() => readWorkerLog(file)).toThrow(SyntaxError);
	});
});
