/**
 * `forge start --no-open --no-compiler` as a real process, with fake Rojo
 * (`test/fixtures/bin/fake-worker.ts`) on PATH and the real reaper. The
 * process table is the oracle: every worker and grandchild must be gone.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, onTestFinished } from "vitest";

import { EXIT_FAILURE, EXIT_SUCCESS, EXIT_USAGE } from "../../src/exit-codes.ts";
import { createFixtureBinDirectory } from "../helpers/fixture-bin.ts";
import { parseLines, parseResult } from "../helpers/output.ts";
import { NATIVE_DIRECTORY } from "../helpers/real-native.ts";
import {
	killWorkers,
	readWorkerLog,
	waitForDeathAsync,
	waitForWorkersAsync,
} from "../helpers/worker-log.ts";
import { BIN, makeProject, runBinAsync } from "./run-bin.ts";

const PATH_NAME = /^path$/i;
const START = ["start", "--no-open", "--no-compiler", "--json"];

interface Fixture {
	environment: (variables?: Record<string, string>) => NodeJS.ProcessEnv;
	log: string;
	port: number;
	project: string;
}

interface Session {
	child: ChildProcessWithoutNullStreams;
	/** Resolves with the exit code once the process has closed. */
	closed: Promise<null | number>;
	stdout: () => string;
}

/**
 * A port nothing listens on right now.
 *
 * @returns A port that was free a moment ago.
 */
async function freePortAsync(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => {
		server.listen({ host: "127.0.0.1", port: 0 }, resolve);
	});
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a TCP server's address is an object
	const { port } = server.address() as AddressInfo;
	await new Promise((resolve) => {
		server.close(resolve);
	});
	return port;
}

/**
 * Listen on `port` of `127.0.0.1` until the test ends.
 *
 * @param port - The port to hold.
 */
async function holdPortAsync(port: number): Promise<void> {
	const server = createServer();
	await new Promise<void>((resolve) => {
		server.listen({ host: "127.0.0.1", port }, resolve);
	});
	onTestFinished(() => {
		server.close();
	});
}

async function makeFixtureAsync(): Promise<Fixture> {
	const port = await freePortAsync();
	const project = makeProject();
	writeFileSync(
		path.join(project, "default.project.json"),
		JSON.stringify({ name: "fixture", tree: { $className: "DataModel" } }),
	);
	writeFileSync(
		path.join(project, "rbx-forge.config.json"),
		JSON.stringify({ projectType: "luau", rojoPort: port }),
	);
	const bin = createFixtureBinDirectory(path.join(project, "fixture-bin"));
	const log = path.join(project, "workers.ndjson");
	mkdirSync(path.join(project, ".forge"), { recursive: true });
	onTestFinished(() => {
		killWorkers(readWorkerLog(log));
	});

	const base: NodeJS.ProcessEnv = { ...process.env, CI: undefined };
	for (const key of Object.keys(base)) {
		if (PATH_NAME.test(key)) {
			delete base[key];
		}
	}

	return {
		environment: (variables = {}) => {
			return {
				...base,
				FIXTURE_LOG: log,
				PATH: bin,
				RBX_FORGE_NATIVE_DIR: NATIVE_DIRECTORY,
				...variables,
			};
		},
		log,
		port,
		project,
	};
}

/**
 * Start `forge start` and keep it running until the test kills it.
 *
 * @param fixture - The project and its environment.
 * @param variables - Fixture variables for the workers.
 * @returns The running process.
 */
function startSession(fixture: Fixture, variables: Record<string, string> = {}): Session {
	const child = spawn(process.execPath, [BIN, ...START], {
		cwd: fixture.project,
		env: fixture.environment(variables),
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	onTestFinished(() => {
		child.kill("SIGKILL");
	});
	let stdout = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.resume();

	return {
		child,
		closed: new Promise((resolve) => {
			child.once("close", resolve);
		}),
		stdout: () => stdout,
	};
}

/**
 * Wait until the session's stdout holds `text`.
 *
 * @param session - The running session.
 * @param text - What to wait for.
 * @rejects When 30 seconds pass first.
 */
async function waitForOutputAsync(session: Session, text: string): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (!session.stdout().includes(text)) {
		if (Date.now() > deadline) {
			throw new Error(`expected "${text}" in:\n${session.stdout()}`);
		}

		await sleep(50);
	}
}

describe("forge start --no-open --no-compiler", () => {
	it("should serve on the fixed port and leave zero survivors when start is hard-killed (L2)", async () => {
		expect.assertions(3);

		const fixture = await makeFixtureAsync();
		const session = startSession(fixture, { FIXTURE_GRANDCHILDREN: "2" });
		const records = await waitForWorkersAsync(fixture.log, 3, 30_000);
		// A hard kill: no handler in forge runs. Only the reaper's stdin EOF
		// is left to end the workers.
		session.child.kill("SIGKILL");
		await session.closed;

		expect(records[0]).toMatchObject({
			args: ["serve", "default.project.json", "--port", String(fixture.port)],
			role: "rojo",
		});
		expect(records.map(({ markers }) => markers.worker)).toStrictEqual([
			"rojo",
			"rojo",
			"rojo",
		]);
		await expect(waitForDeathAsync(records.map(({ pid }) => pid))).resolves.toStrictEqual([]);
	});

	it("should report ready once Rojo runs", async () => {
		expect.assertions(1);

		const fixture = await makeFixtureAsync();
		const session = startSession(fixture);
		await waitForOutputAsync(session, "Press Ctrl+C to stop.");

		expect(parseLines(session.stdout())).toStrictEqual([
			{ name: "rojo serve", status: "started", type: "step" },
			{ name: "rojo serve", status: "succeeded", type: "step" },
			{
				message: `Rojo serves default.project.json on port ${fixture.port}. Press Ctrl+C to stop.`,
				type: "info",
			},
		]);
	});

	// Windows cannot send SIGTERM to another process: `kill` terminates it.
	it.skipIf(process.platform === "win32")(
		"should stop every worker on SIGTERM and exit 0 (L1)",
		async () => {
			expect.assertions(3);

			const fixture = await makeFixtureAsync();
			const session = startSession(fixture, { FIXTURE_GRANDCHILDREN: "2" });
			const records = await waitForWorkersAsync(fixture.log, 3, 30_000);
			session.child.kill("SIGTERM");
			const status = await session.closed;

			expect(status).toBe(EXIT_SUCCESS);
			expect(parseResult(session.stdout()).data).toMatchObject({
				port: fixture.port,
				reason: "SIGTERM",
			});
			await expect(waitForDeathAsync(records.map(({ pid }) => pid))).resolves.toStrictEqual(
				[],
			);
		},
	);

	it("should stop the session with service_failed when Rojo exits, killing what it left", async () => {
		expect.assertions(3);

		const fixture = await makeFixtureAsync();
		const session = startSession(fixture, {
			FIXTURE_EXIT_AFTER_MS: "1500",
			FIXTURE_EXIT_CODE: "3",
			FIXTURE_GRANDCHILDREN: "2",
		});
		const records = await waitForWorkersAsync(fixture.log, 3, 30_000);
		const status = await session.closed;

		expect(status).toBe(EXIT_FAILURE);
		expect(parseResult(session.stdout()).error).toMatchObject({
			code: "service_failed",
			details: { reason: "service_failed:rojo" },
		});
		await expect(waitForDeathAsync(records.map(({ pid }) => pid))).resolves.toStrictEqual([]);
	});

	it("should fail with port_in_use when the fixed port is busy, starting nothing", async () => {
		expect.assertions(3);

		const fixture = await makeFixtureAsync();
		await holdPortAsync(fixture.port);
		const { status, stdout } = await runBinAsync(START, fixture.project, fixture.environment());

		expect(status).toBe(EXIT_FAILURE);
		expect(parseResult(stdout).error!.code).toBe("port_in_use");
		expect(readWorkerLog(fixture.log)).toStrictEqual([]);
	});

	it("should exit 2 without --no-open --no-compiler", async () => {
		expect.assertions(2);

		const fixture = await makeFixtureAsync();
		const { status, stdout } = await runBinAsync(
			["start", "--json"],
			fixture.project,
			fixture.environment(),
		);

		expect(status).toBe(EXIT_USAGE);
		expect(parseResult(stdout).error!.code).toBe("usage");
	});
});
