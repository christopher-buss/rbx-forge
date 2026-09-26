import { describe, expect, it, vi } from "vitest";

import { createCommandContext } from "../../test/helpers/seams.ts";
import type { BuildWatch } from "./build-watch.ts";
import type { AdderSetup } from "./compiler-part.ts";
import { createPartAdder } from "./compiler-part.ts";
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
	const parts = { isRunning: () => false, startAsync };
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
