import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, onTestFinished } from "vitest";

import { createFixtureBinDirectory } from "../helpers/fixture-bin.ts";
import { isProcessAlive, killWorkers, waitForWorkersAsync } from "../helpers/worker-log.ts";

const FAKE_WORKER = path.join(import.meta.dirname, "..", "fixtures", "bin", "fake-worker.ts");

function makeTemporaryDirectory(): string {
	const directory = mkdtempSync(path.join(os.tmpdir(), "forge-fixture-"));
	onTestFinished(() => {
		rmSync(directory, { force: true, recursive: true });
	});

	return directory;
}

function startWorker(role: string, args: Array<string>, environment: Record<string, string>): void {
	const child = spawn(process.execPath, [FAKE_WORKER, role, ...args], {
		env: { ...process.env, ...environment },
		stdio: "ignore",
		windowsHide: true,
	});
	onTestFinished(() => {
		child.kill("SIGKILL");
	});
}

describe("fixture binaries", () => {
	it("should resolve the fake rojo shim from PATH", () => {
		expect.assertions(1);

		const binDirectory = createFixtureBinDirectory(path.join(makeTemporaryDirectory(), "bin"));
		const output = execFileSync("rojo --version", {
			encoding: "utf8",
			env: { ...process.env, PATH: `${binDirectory}${path.delimiter}${process.env["PATH"]}` },
			shell: true,
			windowsHide: true,
		});

		expect(output).toBe("Rojo 7.7.0\n");
	});

	it("should spawn grandchildren that carry the worker markers", async () => {
		expect.assertions(2);

		const logFile = path.join(makeTemporaryDirectory(), "workers.ndjson");
		startWorker("rojo", ["serve"], {
			FIXTURE_GRANDCHILDREN: "2",
			FIXTURE_LOG: logFile,
			RBX_FORGE_SESSION: "session-1",
			RBX_FORGE_WORKER: "rojo-1",
		});

		const records = await waitForWorkersAsync(logFile, 3);
		onTestFinished(() => {
			killWorkers(records);
		});
		const [rojo] = records;
		assert(rojo !== undefined);

		expect(records.map(({ markers }) => markers)).toStrictEqual([
			{ session: "session-1", worker: "rojo-1" },
			{ session: "session-1", worker: "rojo-1" },
			{ session: "session-1", worker: "rojo-1" },
		]);
		expect(records.slice(1).map(({ ppid, role }) => ({ ppid, role }))).toStrictEqual([
			{ ppid: rojo.pid, role: "grandchild" },
			{ ppid: rojo.pid, role: "grandchild" },
		]);
	});

	// Windows has no catchable SIGTERM: `process.kill` there always terminates.
	it.skipIf(process.platform === "win32")(
		"should survive SIGTERM when told to ignore signals",
		async () => {
			expect.assertions(1);

			const logFile = path.join(makeTemporaryDirectory(), "workers.ndjson");
			startWorker("rbxtsc", ["-w"], { FIXTURE_IGNORE_SIGNALS: "1", FIXTURE_LOG: logFile });
			const records = await waitForWorkersAsync(logFile, 1);
			onTestFinished(() => {
				killWorkers(records);
			});
			const [compiler] = records;
			assert(compiler !== undefined);

			process.kill(compiler.pid, "SIGTERM");
			await sleep(200);

			expect(isProcessAlive(compiler.pid)).toBeTrue();
		},
	);
});
