import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

import { makeTemporaryDirectory } from "../helpers/temporary-directory.ts";
import { readWorkerLog } from "../helpers/worker-log.ts";

const FAKE_WORKER = path.join(import.meta.dirname, "..", "fixtures", "bin", "fake-worker.ts");

describe("fixture worker log", () => {
	it("should read a worker record being appended only once it is whole", () => {
		expect.assertions(2);

		const file = path.join(makeTemporaryDirectory(), "workers.ndjson");
		writeFileSync(file, '{"role":"rojo"}\n{"args"');

		expect(readWorkerLog(file)).toStrictEqual([{ role: "rojo" }]);

		appendFileSync(file, ':[],"role":"rbxtsc"}\n');

		expect(readWorkerLog(file)).toStrictEqual([{ role: "rojo" }, { args: [], role: "rbxtsc" }]);
	});

	it("should skip the part of a record its writer was killed in", () => {
		expect.assertions(1);

		const file = path.join(makeTemporaryDirectory(), "workers.ndjson");
		writeFileSync(file, '\n{"role":"rojo"}\n\n{"args":[],"pp\n{"role":"rbxtsc"}\n');

		expect(readWorkerLog(file)).toStrictEqual([{ role: "rojo" }, { role: "rbxtsc" }]);
	});

	it("should keep a worker's record whole after a killed writer's part", () => {
		expect.assertions(1);

		const file = path.join(makeTemporaryDirectory(), "workers.ndjson");
		writeFileSync(file, '{"args":[],"at":1,"event":"start","pp');
		spawnSync(process.execPath, [FAKE_WORKER, "hook"], {
			env: { ...process.env, FIXTURE_LOG: file },
			stdio: "ignore",
			windowsHide: true,
		});

		expect(readWorkerLog(file)).toMatchObject([{ event: "start", role: "hook" }]);
	});
});
