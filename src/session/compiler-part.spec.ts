import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";

import { createManualClock } from "../../test/helpers/manual-clock.ts";
import { createCommandContext, createTestSeams } from "../../test/helpers/seams.ts";
import { ForgeError } from "../errors.ts";
import type { BuildWatch } from "./build-watch.ts";
import { createBuildWatch, FRESH_BUILD_TIMEOUT_MS } from "./build-watch.ts";
import type { AdderSetup } from "./compiler-part.ts";
import { createPartAdder, startCompilerAsync } from "./compiler-part.ts";
import type { PartAdder } from "./part-requests.ts";
import type { SessionScope } from "./run-session.ts";
import type { ServiceParts } from "./service-parts.ts";

function makeScope() {
	return { track: vi.fn<SessionScope["track"]>() };
}

const COMPILER = {
	parsesDiagnostics: true,
	service: { id: "compiler" as const, args: ["-w"], file: "/bin/rbxtsc", step: "rbxtsc watch" },
};

function makeAdder(started: Awaited<ReturnType<ServiceParts["startAsync"]>>) {
	const startAsync = vi.fn<ServiceParts["startAsync"]>().mockResolvedValue(started);
	const restart = vi.fn<BuildWatch["restart"]>();
	const addStudio = vi.fn<PartAdder>().mockResolvedValue([]);
	const setup: AdderSetup = {
		builds: { fail: vi.fn<BuildWatch["fail"]>(), read: vi.fn<BuildWatch["read"]>(), restart },
		context: createCommandContext(),
		resolveCompiler: () => COMPILER,
	};
	const parts = { isRunning: () => false, startAsync, stop: vi.fn<ServiceParts["stop"]>() };
	const add = createPartAdder(setup, makeScope(), parts, addStudio);
	return { add, addStudio, restart, startAsync };
}

describe(createPartAdder, () => {
	it("should start nothing when no part is asked for", async () => {
		expect.assertions(2);

		const { add, startAsync } = makeAdder({ stopped: Promise.resolve() });

		await expect(add({ parts: [] })).resolves.toStrictEqual([]);
		expect(startAsync).not.toHaveBeenCalled();
	});

	it("should name no part when the session ends while the compiler starts", async () => {
		expect.assertions(2);

		const { add, restart } = makeAdder(undefined);

		await expect(add({ parts: ["compiler"] })).resolves.toStrictEqual([]);
		expect(restart).toHaveBeenCalledOnce();
	});

	it("should add Studio and Rojo once the compiler started, and name them after it", async () => {
		expect.assertions(3);

		const { add, addStudio, startAsync } = makeAdder({ stopped: Promise.resolve() });
		addStudio.mockResolvedValue(["studio", "rojo"]);
		const request = { parts: ["compiler", "studio"] as const, studioPath: "/opt/Studio" };

		await expect(add(request)).resolves.toStrictEqual(["compiler", "studio", "rojo"]);
		expect(addStudio).toHaveBeenCalledExactlyOnceWith(request);
		expect(startAsync.mock.invocationCallOrder[0]).toBeLessThan(
			addStudio.mock.invocationCallOrder[0]!,
		);
	});
});

function startStuck() {
	const manual = createManualClock();
	const startAsync = vi.fn<ServiceParts["startAsync"]>().mockResolvedValue({
		stopped: Promise.resolve(),
	});
	const stop = vi.fn<ServiceParts["stop"]>();
	const read = vi.fn<BuildWatch["read"]>();
	const setup = {
		builds: {
			fail: vi.fn<BuildWatch["fail"]>(),
			read,
			restart: vi.fn<BuildWatch["restart"]>(),
		},
		context: createCommandContext({ seams: createTestSeams({ clock: manual.clock }) }),
	};
	return { manual, read, scope: makeScope(), setup, startAsync, stop };
}

const FIRST_BUILD_LATE = `The compiler's first build did not end within ${FRESH_BUILD_TIMEOUT_MS / 1000} s`;

/**
 * Start a compiler that never builds, with a real build watch, and a wait
 * for its build 1 ms before or after it.
 *
 * @param isWaitFirst - Whether the wait begins first.
 * @returns How the wait ended.
 */
async function waitForStuckAsync(isWaitFirst: boolean): Promise<unknown> {
	const manual = createManualClock();
	const context = createCommandContext({ seams: createTestSeams({ clock: manual.clock }) });
	const builds = createBuildWatch({
		clock: manual.clock,
		edits: () => {},
		recorder: { building: vi.fn<() => void>(), compiled: vi.fn<() => void>() },
		tracks: true,
	});
	const startAsync = vi.fn<ServiceParts["startAsync"]>().mockResolvedValue({
		stopped: Promise.resolve(),
	});
	const stop = vi.fn<ServiceParts["stop"]>(() => {
		startAsync.mock.calls[0]![1].onStopped!();
	});
	let outcome: Promise<unknown> = Promise.resolve();
	const steps = [
		async () => {
			const parts = { startAsync, stop };
			await startCompilerAsync({ builds, context }, makeScope(), parts, COMPILER);
		},
		async () => {
			outcome = builds.waitAsync(FRESH_BUILD_TIMEOUT_MS).catch((err: unknown) => err);
		},
	];
	const [first, second] = isWaitFirst ? steps.toReversed() : steps;
	await first!();
	await vi.waitUntil(() => manual.pending() === 1);
	manual.advance(1);
	await second!();
	await vi.waitUntil(() => manual.pending() === 2);
	manual.advance(FRESH_BUILD_TIMEOUT_MS - 1);
	await vi.waitUntil(() => manual.pending() < 2);
	manual.advance(1);
	return outcome;
}

describe(startCompilerAsync, () => {
	it("should fail a compiler whose first build does not end in time", async () => {
		expect.assertions(1);

		const { manual, scope, setup, startAsync, stop } = startStuck();
		await startCompilerAsync(setup, scope, { startAsync, stop }, COMPILER);
		manual.advance(FRESH_BUILD_TIMEOUT_MS);
		await vi.waitUntil(() => stop.mock.calls.length > 0);

		expect(stop).toHaveBeenCalledExactlyOnceWith("compiler", FIRST_BUILD_LATE);
	});

	it("should track the wait for its first build", async () => {
		expect.assertions(1);

		const { scope, setup, startAsync, stop } = startStuck();
		await startCompilerAsync(setup, scope, { startAsync, stop }, COMPILER);

		expect(scope.track).toHaveBeenCalledOnce();
	});

	it.for([
		["the compiler's bound ends first", false, `${FIRST_BUILD_LATE}.`],
		[
			"the wait's bound ends first",
			true,
			`No fresh build within ${FRESH_BUILD_TIMEOUT_MS / 1000} s: the first compile has not ended.`,
		],
	] as const)(
		"should fail a wait for its build with compile_timeout when %s",
		async ([, isWaitFirst, message]) => {
			expect.assertions(3);

			const error = await waitForStuckAsync(isWaitFirst);

			assert(error instanceof ForgeError);

			expect(error.code).toBe("compile_timeout");
			expect(error.message).toBe(message);
			expect(error.hint).toContain("forge logs compiler");
		},
	);

	it("should keep a compiler whose first build ended", async () => {
		expect.assertions(1);

		const { manual, read, scope, setup, startAsync, stop } = startStuck();
		const at = "2026-01-01T00:00:00.000Z";
		read.mockReturnValue({ at, diagnostics: [], errors: 0, startedAt: at });
		await startCompilerAsync(setup, scope, { startAsync, stop }, COMPILER);
		startAsync.mock.calls[0]![1].onLine!("built");
		await vi.waitUntil(() => manual.pending() === 0);
		manual.advance(FRESH_BUILD_TIMEOUT_MS);

		expect(stop).not.toHaveBeenCalled();
	});
});
