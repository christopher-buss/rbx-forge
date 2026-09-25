import { describe, expect, it } from "vitest";

import { createFakeSpawner } from "../../test/helpers/fake-process.ts";
import type { FakeChild, SpawnCall } from "../../test/helpers/fake-process.ts";
import { createManualClock } from "../../test/helpers/manual-clock.ts";
import type { ManualClock } from "../../test/helpers/manual-clock.ts";
import type { FakeNative, FakeProcess } from "../../test/helpers/native.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import { ForgeError } from "../errors.ts";
import type { WorkerReport, WorkerSpec } from "./protocol.ts";
import type { Reaper } from "./reaper-client.ts";
import {
	createReaperLauncher,
	FORCED_CLEANUP_MS,
	launchReaperAsync,
	ORPHAN_WAIT_MS,
	TERMINATE_MARGIN_MS,
} from "./reaper-client.ts";

const OPTIONS = {
	file: "/bin/forge-reaper",
	leasePath: "/p/workers.lock",
	recordPath: "/p/reaper.json",
	sessionId: "s-1",
};
const WORKER: WorkerSpec = { id: "rojo", args: ["serve"], cwd: "/p", env: {}, file: "/bin/rojo" };
const REPORT: WorkerReport = { exitCode: 0, forced: false, incomplete: false, signal: null };
/** A worker leader the fake native addon knows; its start time is its PID. */
const LEADER = 4242;

interface HarnessOptions {
	nativeThrows?: boolean;
	platform?: NodeJS.Platform;
	processes?: Record<number, FakeProcess>;
}

interface Harness {
	call: SpawnCall;
	child: FakeChild;
	clock: ManualClock;
	launching: Promise<Reaper>;
	native: FakeNative;
	/** Every request written to the reaper's stdin so far. */
	requests: () => Array<unknown>;
	/** Write one event line to the reaper's stdout. */
	say: (event: object) => void;
}

async function flushAsync(): Promise<void> {
	await new Promise((resolve) => {
		setImmediate(resolve);
	});
}

function startLaunch({
	nativeThrows = false,
	platform = "linux",
	processes = {},
}: HarnessOptions = {}): Harness {
	const spawner = createFakeSpawner();
	const clock = createManualClock();
	const native = createFakeNative(processes);
	const launching = launchReaperAsync(
		{
			childProcess: spawner.runner,
			clock: clock.clock,
			host: { platform },
			native: () => {
				if (nativeThrows) {
					throw new ForgeError("native_missing", "no addon");
				}

				return native.addon;
			},
		},
		OPTIONS,
	);
	const child = spawner.children[0]!;
	let written = "";
	child.stdin.setEncoding("utf8");
	child.stdin.on("data", (chunk: string) => {
		written += chunk;
	});

	return {
		call: spawner.calls[0]!,
		child,
		clock,
		launching,
		native,
		requests: () => {
			return written
				.split("\n")
				.filter((line) => line !== "")
				.map((line): unknown => JSON.parse(line));
		},
		say: (event) => {
			child.stdout.write(`${JSON.stringify(event)}\n`);
		},
	};
}

async function launchedAsync(options: HarnessOptions = {}): Promise<Harness & { reaper: Reaper }> {
	const harness = startLaunch(options);
	harness.say({ pid: 77, type: "leased" });
	return { ...harness, reaper: await harness.launching };
}

describe(launchReaperAsync, () => {
	it("should start the reaper in its own session on POSIX, hidden, with piped streams", async () => {
		expect.assertions(3);

		const { call, reaper } = await launchedAsync();

		expect(call.file).toBe("/bin/forge-reaper");
		expect(call.args).toStrictEqual([
			"serve",
			"--session",
			"s-1",
			"--lease",
			"/p/workers.lock",
			"--record",
			"/p/reaper.json",
		]);
		expect([call.options, reaper.pid]).toStrictEqual([
			{ detached: true, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
			77,
		]);
	});

	it("should keep the reaper in the host's console on Windows", async () => {
		expect.assertions(1);

		const { call } = await launchedAsync({ platform: "win32" });

		expect(call.options).toMatchObject({ detached: false });
	});

	it("should fail with reaper_unavailable and its stderr when it exits before the lease", async () => {
		expect.assertions(1);

		const { child, launching } = startLaunch();
		child.stderr.write(`${"x".repeat(3000)}lease is held\n`);
		await flushAsync();
		child.close(1);

		await expect(launching).rejects.toMatchObject({
			code: "reaper_unavailable",
			message: `The reaper (/bin/forge-reaper) exited before it took the lease.\n${"x".repeat(1986)}lease is held`,
		});
	});

	it("should name no stderr when the reaper wrote none", async () => {
		expect.assertions(1);

		const { child, launching } = startLaunch();
		child.close(1);

		await expect(launching).rejects.toThrow(
			/^The reaper \(\/bin\/forge-reaper\) exited before it took the lease\.$/,
		);
	});

	it("should fail with reaper_unavailable when the process cannot start", async () => {
		expect.assertions(1);

		const { child, launching } = startLaunch();
		child.error(new Error("spawn ENOENT"));

		await expect(launching).rejects.toMatchObject({ code: "reaper_unavailable" });
	});

	it("should ignore lines that are not events", async () => {
		expect.assertions(1);

		const { child, launching, say } = startLaunch();
		child.stdout.write("forge-reaper: ignored line\n");
		say({ pid: 5, type: "leased" });

		await expect(launching).resolves.toMatchObject({ pid: 5 });
	});
});

describe("reaper requests", () => {
	it("should write go, stop, and terminate in order", async () => {
		expect.assertions(1);

		const { reaper, requests } = await launchedAsync();
		reaper.go();
		reaper.stop("rojo", 250);
		void reaper.terminateAsync(100);
		await flushAsync();

		expect(requests()).toStrictEqual([
			{ type: "go" },
			{ id: "rojo", graceMs: 250, type: "stop" },
			{ graceMs: 100, type: "terminate" },
		]);
	});

	it("should resolve a spawn with its pid and start time, and its exit with the report", async () => {
		expect.assertions(3);

		const { reaper, requests, say } = await launchedAsync();
		const spawning = reaper.spawnAsync(WORKER);
		await flushAsync();
		say({ id: "rojo", pid: 9, startTime: "99", type: "spawned" });
		const worker = await spawning;
		say({ id: "rojo", report: REPORT, type: "exited" });

		expect(requests()).toStrictEqual([
			{
				id: "rojo",
				args: ["serve"],
				cwd: "/p",
				env: {},
				file: "/bin/rojo",
				type: "spawn",
				verbatim: false,
			},
		]);
		expect(worker).toMatchObject({ id: "rojo", pid: 9, startTime: "99" });
		await expect(worker.exited).resolves.toStrictEqual(REPORT);
	});

	it("should reject a spawn the reaper rejects, naming the reason", async () => {
		expect.assertions(1);

		const { reaper, say } = await launchedAsync();
		const spawning = reaper.spawnAsync(WORKER);
		say({ id: "rojo", message: "no such file", reason: "spawn_failed", type: "rejected" });

		await expect(spawning).rejects.toMatchObject({
			code: "process_failed",
			details: { reason: "spawn_failed" },
			message: "The reaper did not start rojo: no such file",
		});
	});

	it("should reject a spawn that is pending when the reaper exits", async () => {
		expect.assertions(1);

		const { child, reaper } = await launchedAsync();
		const spawning = reaper.spawnAsync(WORKER);
		child.stderr.write("panic\n");
		await flushAsync();
		child.close(101);

		await expect(spawning).rejects.toMatchObject({
			code: "reaper_unavailable",
			message: "The reaper exited before it started rojo.\npanic",
		});
	});

	it("should reject a spawn at once after the reaper exited", async () => {
		expect.assertions(2);

		const { child, reaper, requests } = await launchedAsync();
		// A write to a dead reaper fails; that must not crash the host.
		child.stdin.emit("error", new Error("write EPIPE"));
		child.close(0);
		await reaper.ended;

		await expect(reaper.spawnAsync(WORKER)).rejects.toMatchObject({
			code: "reaper_unavailable",
		});
		expect(requests()).toStrictEqual([]);
	});
});

describe("reaper end", () => {
	it("should return the reaper's own reports after terminated, without escalating", async () => {
		expect.assertions(3);

		const { child, clock, reaper, say } = await launchedAsync();
		const ending = reaper.terminateAsync(1000);
		say({ reports: [{ id: "rojo", report: REPORT }], type: "terminated" });
		await flushAsync();
		child.close(0);

		await expect(ending).resolves.toStrictEqual({
			reports: [{ id: "rojo", report: REPORT }],
			terminated: true,
		});
		expect(child.stdin.writableEnded).toBeFalse();
		// The wait's timer is gone once the reaper exited.
		expect(clock.pending()).toBe(0);
	});

	it("should close stdin after the grace and margin, then clean up by force after one more margin", async () => {
		expect.assertions(4);

		const { child, clock, native, reaper } = await launchedAsync();
		void reaper.terminateAsync(1000);
		await flushAsync();
		clock.advance(1000 + TERMINATE_MARGIN_MS - 1);
		await flushAsync();

		expect(child.stdin.writableEnded).toBeFalse();

		clock.advance(1);
		await flushAsync();

		expect(child.stdin.writableEnded).toBeTrue();

		clock.advance(TERMINATE_MARGIN_MS - 1);
		await flushAsync();

		expect(native.cleanups).toStrictEqual([]);

		clock.advance(1);
		await flushAsync();

		expect(native.cleanups).toStrictEqual([
			{
				boundMs: FORCED_CLEANUP_MS,
				target: {
					leasePath: "/p/workers.lock",
					recordPath: "/p/reaper.json",
					sessionId: "s-1",
				},
			},
		]);
	});

	it("should kill a reaper that still runs a moment after the forced cleanup", async () => {
		expect.assertions(3);

		const { child, clock, reaper } = await launchedAsync();
		const ending = reaper.terminateAsync(0);
		await flushAsync();
		clock.advance(TERMINATE_MARGIN_MS);
		await flushAsync();
		clock.advance(TERMINATE_MARGIN_MS);
		await flushAsync();
		clock.advance(ORPHAN_WAIT_MS - 1);
		await flushAsync();

		expect(child.kills).toStrictEqual([]);

		clock.advance(1);
		await flushAsync();

		expect(child.kills).toStrictEqual(["SIGKILL"]);
		await expect(ending).resolves.toStrictEqual({
			escalation: "forced_cleanup",
			reports: [],
			terminated: false,
		});
	});

	it("should not kill a reaper that the forced cleanup ended", async () => {
		expect.assertions(2);

		const { child, clock, native, reaper } = await launchedAsync();
		native.addon.forceCleanup = async () => {
			child.close(null, "SIGKILL");
			return { killed: [77], survivors: [], unverifiable: [] };
		};

		const ending = reaper.terminateAsync(0);
		await flushAsync();
		clock.advance(TERMINATE_MARGIN_MS);
		await flushAsync();
		clock.advance(TERMINATE_MARGIN_MS);

		await expect(ending).resolves.toMatchObject({ escalation: "forced_cleanup" });
		expect(child.kills).toStrictEqual([]);
	});

	it("should kill the reaper when the forced cleanup fails", async () => {
		expect.assertions(1);

		const { child, clock, reaper } = await launchedAsync({ nativeThrows: true });
		const ending = reaper.terminateAsync(0);
		await flushAsync();
		clock.advance(TERMINATE_MARGIN_MS);
		await flushAsync();
		clock.advance(TERMINATE_MARGIN_MS);
		await flushAsync();
		clock.advance(ORPHAN_WAIT_MS);
		await ending;

		expect(child.kills).toStrictEqual(["SIGKILL"]);
	});

	it("should not kill a reaper that exits after its stdin closed", async () => {
		expect.assertions(4);

		const { child, clock, native, reaper } = await launchedAsync();
		const ending = reaper.terminateAsync(0);
		await flushAsync();
		clock.advance(TERMINATE_MARGIN_MS);
		await flushAsync();
		child.close(0);
		const end = await ending;
		const pending = clock.pending();
		clock.advance(TERMINATE_MARGIN_MS);

		expect(end).toStrictEqual({ escalation: "stdin_closed", reports: [], terminated: false });
		expect(child.kills).toStrictEqual([]);
		expect(native.cleanups).toStrictEqual([]);
		expect(pending).toBe(0);
	});

	it("should kill the tree of every worker a dead reaper left, through a verified pin", async () => {
		expect.assertions(3);

		const { child, native, reaper, say } = await launchedAsync({
			processes: { [LEADER]: { alive: true, executablePath: "/bin/rojo", waits: [] } },
		});
		const spawning = reaper.spawnAsync(WORKER);
		say({ id: "rojo", pid: LEADER, startTime: String(LEADER), type: "spawned" });
		const worker = await spawning;
		child.close(null, "SIGKILL");

		await expect(reaper.ended).resolves.toStrictEqual({
			reports: [{ id: "rojo", report: { ...REPORT, exitCode: null, forced: true } }],
			terminated: false,
		});
		await expect(worker.exited).resolves.toMatchObject({ forced: true, incomplete: false });
		expect(native.processes.get(LEADER)).toMatchObject({
			alive: false,
			groupKilled: true,
			waits: [ORPHAN_WAIT_MS],
		});
	});

	it("should report a left worker that outlives the kill as incomplete", async () => {
		expect.assertions(1);

		const { child, reaper, say } = await launchedAsync({
			processes: {
				[LEADER]: { alive: true, executablePath: "/bin/rojo", ignoresKill: true },
			},
		});
		const spawning = reaper.spawnAsync(WORKER);
		say({ id: "rojo", pid: LEADER, startTime: String(LEADER), type: "spawned" });
		await spawning;
		child.close(null, "SIGKILL");

		await expect(reaper.ended).resolves.toMatchObject({
			reports: [{ report: { incomplete: true } }],
		});
	});

	it("should kill nothing when the PID now names another process", async () => {
		expect.assertions(2);

		const { child, native, reaper, say } = await launchedAsync({
			processes: { [LEADER]: { alive: true, executablePath: "/bin/other" } },
		});
		const spawning = reaper.spawnAsync(WORKER);
		say({ id: "rojo", pid: LEADER, startTime: "1", type: "spawned" });
		await spawning;
		child.close(null, "SIGKILL");

		await expect(reaper.ended).resolves.toMatchObject({
			reports: [{ report: { incomplete: false } }],
		});
		expect(native.processes.get(LEADER)).toMatchObject({ alive: true });
	});

	it("should treat a left worker that is already gone as done", async () => {
		expect.assertions(1);

		const { child, reaper, say } = await launchedAsync();
		const spawning = reaper.spawnAsync(WORKER);
		say({ id: "rojo", pid: LEADER, startTime: String(LEADER), type: "spawned" });
		await spawning;
		child.close(null, "SIGKILL");

		await expect(reaper.ended).resolves.toMatchObject({
			reports: [{ report: { incomplete: false } }],
		});
	});

	it("should report a left worker as incomplete when the native addon fails", async () => {
		expect.assertions(1);

		const { child, reaper, say } = await launchedAsync({ nativeThrows: true });
		const spawning = reaper.spawnAsync(WORKER);
		say({ id: "rojo", pid: LEADER, startTime: String(LEADER), type: "spawned" });
		await spawning;
		child.close(null, "SIGKILL");

		await expect(reaper.ended).resolves.toMatchObject({
			reports: [{ report: { incomplete: true } }],
		});
	});

	it("should keep reports of workers that exited before the reaper died", async () => {
		expect.assertions(1);

		const { child, reaper, say } = await launchedAsync();
		const spawning = reaper.spawnAsync(WORKER);
		say({ id: "rojo", pid: 9, startTime: "9", type: "spawned" });
		await spawning;
		say({ id: "rojo", report: REPORT, type: "exited" });
		await flushAsync();
		child.close(null, "SIGKILL");

		await expect(reaper.ended).resolves.toStrictEqual({
			reports: [{ id: "rojo", report: REPORT }],
			terminated: false,
		});
	});
});

describe(createReaperLauncher, () => {
	function makeLauncher(locate: () => string): {
		launch: ReturnType<typeof createReaperLauncher>;
		spawner: ReturnType<typeof createFakeSpawner>;
	} {
		const spawner = createFakeSpawner((child) => {
			child.stdout.write('{"type":"leased","pid":3}\n');
		});
		const launch = createReaperLauncher(
			{
				childProcess: spawner.runner,
				clock: createManualClock().clock,
				host: { platform: "linux" },
				native: () => createFakeNative().addon,
			},
			locate,
		);
		return { launch, spawner };
	}

	it("should launch the binary it finds", async () => {
		expect.assertions(2);

		const { launch, spawner } = makeLauncher(() => "/native/forge-reaper");

		await expect(
			launch({ leasePath: "/l", recordPath: "/r", sessionId: "s" }),
		).resolves.toMatchObject({
			pid: 3,
		});
		expect(spawner.calls.map(({ file }) => file)).toStrictEqual(["/native/forge-reaper"]);
	});

	it("should start nothing when no binary is found", async () => {
		expect.assertions(2);

		const error = new ForgeError("reaper_unavailable", "missing");
		const { launch, spawner } = makeLauncher(() => {
			throw error;
		});

		await expect(launch({ leasePath: "/l", recordPath: "/r", sessionId: "s" })).rejects.toBe(
			error,
		);
		expect(spawner.calls).toStrictEqual([]);
	});
});
