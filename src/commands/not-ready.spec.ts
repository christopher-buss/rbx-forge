import { describe, expect, it } from "vitest";

import { makeStatus } from "../../test/helpers/fake-session.ts";
import { failedError, noteWaited, notReadyError } from "./not-ready.ts";

describe(failedError, () => {
	it("should fail with service_failed and the failure of a Rojo forge stopped", () => {
		expect.assertions(1);

		const { services } = makeStatus();
		services.rojo = { ...services.rojo, failure: "rojo did not listen", status: "failed" };

		expect(failedError(services, new Set(["rojo"]))).toMatchObject({
			code: "service_failed",
			hint: 'Read its output with "forge logs rojo".',
			message: "rojo did not listen.",
		});
	});

	it("should name no part it did not wait for", () => {
		expect.assertions(1);

		const { services } = makeStatus();
		services.rojo = { ...services.rojo, failure: "rojo did not listen", status: "failed" };

		expect(failedError(services, new Set(["compiler"]))).toBeUndefined();
	});

	it("should name no part it waited for that did not fail", () => {
		expect.assertions(1);

		const { services } = makeStatus();
		services.rojo = { ...services.rojo, failure: "rojo did not listen", status: "off" };

		expect(failedError(services, new Set(["rojo"]))).toBeUndefined();
	});
});

describe(noteWaited, () => {
	it("should note only the parts that are starting", () => {
		expect.assertions(1);

		const { services } = makeStatus();
		services.compiler = { ...services.compiler, status: "starting" };
		const waited = new Set<"compiler" | "rojo">();
		noteWaited(waited, services);

		expect([...waited]).toStrictEqual(["compiler"]);
	});
});

describe(notReadyError, () => {
	it("should fail with studio_launch_failed for a Studio that is opening", () => {
		expect.assertions(1);

		const { services } = makeStatus();
		services.studio = { ...services.studio, status: "opening" };

		expect(notReadyError(services, 5000)).toMatchObject({
			code: "studio_launch_failed",
			hint: 'Check "forge status" and Studio\'s Rojo connection.',
			message: "Studio was not ready within 5 s.",
		});
	});
});
