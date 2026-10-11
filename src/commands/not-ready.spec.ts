import { describe, expect, it } from "vitest";

import { makeStatus } from "../../test/helpers/fake-session.ts";
import { failedError } from "./not-ready.ts";

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
		services.rojo = { ...services.rojo, status: "failed" };

		expect(failedError(services, new Set(["compiler"]))).toBeUndefined();
	});
});
