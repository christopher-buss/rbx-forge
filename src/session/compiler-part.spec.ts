import { describe, expect, it, vi } from "vitest";

import { createManualClock } from "../../test/helpers/manual-clock.ts";
import { createCommandContext, createTestSeams } from "../../test/helpers/seams.ts";
import type { BuildWatch } from "./build-watch.ts";
import { FRESH_BUILD_TIMEOUT_MS } from "./build-watch.ts";
import type { AdderSetup } from "./compiler-part.ts";
import { createPartAdder, startCompilerAsync } from "./compiler-part.ts";
import type { PartAdder } from "./part-requests.ts";
import type { ServiceParts } from "./service-parts.ts";

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
	return { add: createPartAdder(setup, parts, addStudio), addStudio, restart, startAsync };
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
	return { manual, read, setup, startAsync, stop };
}

describe(startCompilerAsync, () => {
	it("should fail a compiler whose first build does not end in time", async () => {
		expect.assertions(1);

		const { manual, setup, startAsync, stop } = startStuck();
		await startCompilerAsync(setup, { startAsync, stop }, COMPILER);
		manual.advance(FRESH_BUILD_TIMEOUT_MS);
		await vi.waitUntil(() => stop.mock.calls.length > 0);

		expect(stop).toHaveBeenCalledExactlyOnceWith(
			"compiler",
			"The compiler's first build did not end within 300 s",
		);
	});

	it("should keep a compiler whose first build ended", async () => {
		expect.assertions(1);

		const { manual, read, setup, startAsync, stop } = startStuck();
		const at = "2026-01-01T00:00:00.000Z";
		read.mockReturnValue({ at, diagnostics: [], errors: 0, startedAt: at });
		await startCompilerAsync(setup, { startAsync, stop }, COMPILER);
		startAsync.mock.calls[0]![1].onLine!("built");
		await vi.waitUntil(() => manual.pending() === 0);
		manual.advance(FRESH_BUILD_TIMEOUT_MS);

		expect(stop).not.toHaveBeenCalled();
	});
});
