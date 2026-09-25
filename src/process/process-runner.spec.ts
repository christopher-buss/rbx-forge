import { fromAny } from "@total-typescript/shoehorn";

import type { SpawnOptions } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import { createFailingSpawner, createFakeSpawner } from "../../test/helpers/fake-process.ts";
import type { FakeChild, SpawnBehavior } from "../../test/helpers/fake-process.ts";
import { createManualClock } from "../../test/helpers/manual-clock.ts";
import type { ManualClock } from "../../test/helpers/manual-clock.ts";
import { createTestSeams } from "../../test/helpers/seams.ts";
import type { ChildProcessRunner } from "../seams/child-process.ts";
import type { Host } from "../seams/host.ts";
import type { ProcessRunner, ProcessSpec } from "./process-runner.ts";
import { createChildProcessRunner, OUTPUT_TAIL_LINES } from "./process-runner.ts";

interface RunnerSetup {
	childProcess?: ChildProcessRunner;
	clock?: ManualClock;
	platform?: NodeJS.Platform;
}

interface Runner {
	clock: ManualClock;
	kill: ReturnType<typeof vi.fn<Host["kill"]>>;
	run: ProcessRunner;
}

const SPEC: ProcessSpec = {
	args: ["build", "--output", "game.rbxl"],
	cwd: "/project",
	env: { PATH: "/bin" },
	file: "/bin/rojo",
};

function makeRunner({
	childProcess = createFakeSpawner().runner,
	clock = createManualClock(),
	platform = "linux",
}: RunnerSetup = {}): Runner {
	const kill = vi.fn<Host["kill"]>();
	return {
		clock,
		kill,
		run: createChildProcessRunner({
			childProcess,
			clock: clock.clock,
			host: { ...createTestSeams().host, kill, platform },
		}),
	};
}

function exitWith(exitCode: number, output: Array<string> = []): SpawnBehavior {
	return (child) => {
		for (const chunk of output) {
			child.stdout.write(chunk);
		}

		child.close(exitCode);
	};
}

/**
 * The first child runs past its timeout; taskkill then closes it.
 *
 * @param clock - Advanced past the timeout once the target runs.
 * @param target - The process taskkill ends.
 * @returns The spawn behavior.
 */
function taskkillClosesTarget(clock: ManualClock, target: () => FakeChild): SpawnBehavior {
	return (child, { file }) => {
		if (!file.endsWith("taskkill.exe")) {
			clock.advance(10);
			return;
		}

		target().close(1);
		child.close(0);
	};
}

/**
 * A spawner whose first child runs past its timeout and whose taskkill
 * cannot start.
 *
 * @param clock - Advanced past the timeout once the target runs.
 * @returns The seam and the children it made.
 */
function taskkillMissing(clock: ManualClock): {
	children: Array<FakeChild>;
	runner: ChildProcessRunner;
} {
	const spawner = createFakeSpawner(() => {
		clock.advance(10);
	});
	const failing = createFailingSpawner("ENOENT");

	return {
		children: spawner.children,
		runner: {
			spawn: fromAny((file: string, args: Array<string>, options: SpawnOptions) => {
				if (spawner.children.length === 0) {
					return spawner.runner.spawn(file, args, options);
				}

				return failing.spawn(file, args, options);
			}),
		},
	};
}

describe(createChildProcessRunner, () => {
	it("should spawn the file hidden, with piped output and no stdin", async () => {
		expect.assertions(1);

		const spawner = createFakeSpawner(exitWith(0));
		await makeRunner({ childProcess: spawner.runner }).run(SPEC);

		expect(spawner.calls).toStrictEqual([
			{
				args: ["build", "--output", "game.rbxl"],
				file: "/bin/rojo",
				options: {
					cwd: "/project",
					detached: true,
					env: { PATH: "/bin" },
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
					windowsVerbatimArguments: false,
				},
			},
		]);
	});

	it("should keep a Windows child in the console's group and pass verbatim arguments on", async () => {
		expect.assertions(1);

		const spawner = createFakeSpawner(exitWith(0));
		await makeRunner({ childProcess: spawner.runner, platform: "win32" }).run({
			...SPEC,
			verbatimArguments: true,
		});

		expect(spawner.calls[0]!.options).toMatchObject({
			detached: false,
			windowsVerbatimArguments: true,
		});
	});

	it("should report the exit code, the duration, and the output tail", async () => {
		expect.assertions(1);

		const clock = createManualClock(5000);
		const spawner = createFakeSpawner((child) => {
			child.stdout.write("Building...\r\n");
			clock.advance(250);
			child.stderr.write("warning: slow\n");
			child.close(3);
		});

		await expect(
			makeRunner({ childProcess: spawner.runner, clock }).run(SPEC),
		).resolves.toStrictEqual({
			durationMs: 250,
			exitCode: 3,
			outputTail: ["Building...", "warning: slow"],
			signal: null,
			type: "exited",
		});
	});

	it("should join lines split across chunks and keep a last line with no newline", async () => {
		expect.assertions(1);

		const spawner = createFakeSpawner(exitWith(0, ["Built the pl", "ace\nAll do", "ne"]));

		await expect(makeRunner({ childProcess: spawner.runner }).run(SPEC)).resolves.toMatchObject(
			{
				outputTail: ["Built the place", "All done"],
			},
		);
	});

	it("should keep only the last lines of long output", async () => {
		expect.assertions(1);

		const lines = Array.from({ length: OUTPUT_TAIL_LINES + 5 }, (_, index) => `line ${index}`);
		const spawner = createFakeSpawner(exitWith(0, [`${lines.join("\n")}\n`]));

		await expect(makeRunner({ childProcess: spawner.runner }).run(SPEC)).resolves.toMatchObject(
			{
				outputTail: lines.slice(5),
			},
		);
	});

	it("should keep only the last lines when the output ends mid-line", async () => {
		expect.assertions(1);

		const lines = Array.from({ length: OUTPUT_TAIL_LINES }, (_, index) => `line ${index}`);
		const spawner = createFakeSpawner(exitWith(0, [`${lines.join("\n")}\nno newline`]));

		await expect(makeRunner({ childProcess: spawner.runner }).run(SPEC)).resolves.toMatchObject(
			{
				outputTail: [...lines.slice(1), "no newline"],
			},
		);
	});

	it("should hand every output line to onLine, past the tail and a last partial line", async () => {
		expect.assertions(1);

		const lines = Array.from({ length: OUTPUT_TAIL_LINES + 5 }, (_, index) => `line ${index}`);
		const spawner = createFakeSpawner((child) => {
			child.stdout.write(`${lines.join("\r\n")}\r\nsplit `);
			child.stderr.write("line\nno newline");
			child.close(1);
		});
		const seen: Array<string> = [];
		await makeRunner({ childProcess: spawner.runner }).run({
			...SPEC,
			onLine: (line) => {
				seen.push(line);
			},
		});

		expect(seen).toStrictEqual([...lines, "split line", "no newline"]);
	});

	it("should hand no partial line to onLine when the output ends with a newline", async () => {
		expect.assertions(1);

		const spawner = createFakeSpawner(exitWith(0, ["done\n"]));
		const seen: Array<string> = [];
		await makeRunner({ childProcess: spawner.runner }).run({
			...SPEC,
			onLine: (line) => {
				seen.push(line);
			},
		});

		expect(seen).toStrictEqual(["done"]);
	});

	it("should report a process a signal ended", async () => {
		expect.assertions(1);

		const spawner = createFakeSpawner((child) => {
			child.close(null, "SIGTERM");
		});

		await expect(makeRunner({ childProcess: spawner.runner }).run(SPEC)).resolves.toMatchObject(
			{
				exitCode: null,
				signal: "SIGTERM",
				type: "exited",
			},
		);
	});

	it("should report a process that could not start", async () => {
		expect.assertions(1);

		await expect(
			makeRunner({ childProcess: createFailingSpawner("ENOENT") }).run(SPEC),
		).resolves.toStrictEqual({
			errorCode: "ENOENT",
			message: "spawn /bin/rojo ENOENT",
			type: "spawn_failed",
		});
	});

	it("should stop waiting for the timeout once the process exits", async () => {
		expect.assertions(2);

		const { clock, run } = makeRunner({ childProcess: createFakeSpawner(exitWith(0)).runner });

		await expect(run({ ...SPEC, timeoutMs: 1000 })).resolves.toMatchObject({ type: "exited" });
		expect(clock.pending()).toBe(0);
	});

	it("should kill the process group of a POSIX process that outlives its timeout", async () => {
		expect.assertions(2);

		const spawner = createFakeSpawner((child) => {
			child.stdout.write("still going\n");
			clock.advance(1000);
		});
		const clock = createManualClock(5000);
		const { kill, run } = makeRunner({ childProcess: spawner.runner, clock });
		kill.mockImplementation(() => {
			spawner.children[0]!.close(null, "SIGKILL");
		});

		await expect(run({ ...SPEC, timeoutMs: 1000 })).resolves.toStrictEqual({
			durationMs: 1000,
			outputTail: ["still going"],
			type: "timed_out",
		});
		expect(kill).toHaveBeenCalledExactlyOnceWith(-1000, "SIGKILL");
	});

	it("should still wait for the process when its group is already gone", async () => {
		expect.assertions(1);

		const spawner = createFakeSpawner(() => {
			clock.advance(10);
		});
		const clock = createManualClock();
		const { kill, run } = makeRunner({ childProcess: spawner.runner, clock });
		kill.mockImplementation(() => {
			spawner.children[0]!.close(null, "SIGKILL");
			throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
		});

		await expect(run({ ...SPEC, timeoutMs: 10 })).resolves.toMatchObject({ type: "timed_out" });
	});

	it("should kill the process tree of a Windows process with taskkill", async () => {
		expect.assertions(3);

		const clock = createManualClock();
		const spawner = createFakeSpawner(taskkillClosesTarget(clock, () => spawner.children[0]!));
		const { run } = makeRunner({ childProcess: spawner.runner, clock, platform: "win32" });

		await expect(
			run({ ...SPEC, env: { SYSTEMROOT: "D:\\Win" }, timeoutMs: 10 }),
		).resolves.toMatchObject({ type: "timed_out" });
		expect(spawner.children[0]!.kills).toStrictEqual([]);
		expect(spawner.calls[1]).toStrictEqual({
			args: ["/pid", "1000", "/T", "/F"],
			file: "D:\\Win\\System32\\taskkill.exe",
			options: { stdio: "ignore", windowsHide: true },
		});
	});

	it("should find taskkill in C:\\Windows without SystemRoot", async () => {
		expect.assertions(1);

		const clock = createManualClock();
		const spawner = createFakeSpawner(taskkillClosesTarget(clock, () => spawner.children[0]!));
		const { run } = makeRunner({ childProcess: spawner.runner, clock, platform: "win32" });
		await run({ ...SPEC, timeoutMs: 10 });

		expect(spawner.calls[1]!.file).toBe("C:\\Windows\\System32\\taskkill.exe");
	});

	it("should kill the process alone when taskkill cannot start", async () => {
		expect.assertions(2);

		const clock = createManualClock();
		const { children, runner } = taskkillMissing(clock);
		const { run } = makeRunner({ childProcess: runner, clock, platform: "win32" });

		await expect(run({ ...SPEC, timeoutMs: 10 })).resolves.toMatchObject({ type: "timed_out" });
		expect(children[0]!.kills).toStrictEqual(["SIGKILL"]);
	});

	it("should stop reading output a killed process's descendants still hold", async () => {
		expect.assertions(2);

		const spawner = createFakeSpawner(() => {
			clock.advance(10);
		});
		const clock = createManualClock();
		const { kill, run } = makeRunner({ childProcess: spawner.runner, clock });
		kill.mockImplementation(() => {
			// The process exits; a descendant keeps its pipes open.
			spawner.children[0]!.exit(null, "SIGKILL");
		});

		await expect(run({ ...SPEC, timeoutMs: 10 })).resolves.toMatchObject({ type: "timed_out" });
		expect(spawner.children[0]!.stdout.destroyed).toBeTrue();
	});

	it("should hand the last partial line of a timed-out process to onLine", async () => {
		expect.assertions(1);

		const clock = createManualClock();
		const spawner = createFakeSpawner((child) => {
			child.stdout.write("working");
			// Let the chunk arrive before the timeout fires.
			setImmediate(() => {
				clock.advance(10);
			});
		});
		const { kill, run } = makeRunner({ childProcess: spawner.runner, clock });
		kill.mockImplementation(() => {
			spawner.children[0]!.close(null, "SIGKILL");
		});
		const seen: Array<string> = [];
		await run({
			...SPEC,
			onLine: (line) => {
				seen.push(line);
			},
			timeoutMs: 10,
		});

		expect(seen).toStrictEqual(["working"]);
	});
});
