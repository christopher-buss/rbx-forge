import { describe, expect, it, vi } from "vitest";

import { createCommandContext } from "../../test/helpers/seams.ts";
import type { BuildWatch } from "./build-watch.ts";
import type { AdderSetup } from "./compiler-part.ts";
import { createPartAdder } from "./compiler-part.ts";
import type { ServiceParts } from "./service-parts.ts";

const COMPILER = {
	parsesDiagnostics: true,
	service: { id: "compiler" as const, args: ["-w"], file: "/bin/rbxtsc", step: "rbxtsc watch" },
};

function makeAdder(started: Awaited<ReturnType<ServiceParts["startAsync"]>>) {
	const startAsync = vi.fn<ServiceParts["startAsync"]>().mockResolvedValue(started);
	const restart = vi.fn<BuildWatch["restart"]>();
	const setup: AdderSetup = {
		builds: { fail: vi.fn<BuildWatch["fail"]>(), read: vi.fn<BuildWatch["read"]>(), restart },
		context: createCommandContext(),
		resolveCompiler: () => COMPILER,
	};
	const parts: ServiceParts = {
		isRunning: () => false,
		startAsync,
		stop: vi.fn<ServiceParts["stop"]>(),
	};
	return { add: createPartAdder(setup, parts), restart, startAsync };
}

describe(createPartAdder, () => {
	it("should start nothing when no part is asked for", async () => {
		expect.assertions(2);

		const { add, startAsync } = makeAdder({ stopped: Promise.resolve() });

		await expect(add([])).resolves.toStrictEqual([]);
		expect(startAsync).not.toHaveBeenCalled();
	});

	it("should name no part when the session ends while the compiler starts", async () => {
		expect.assertions(2);

		const { add, restart } = makeAdder(undefined);

		await expect(add(["compiler"])).resolves.toStrictEqual([]);
		expect(restart).toHaveBeenCalledOnce();
	});
});
