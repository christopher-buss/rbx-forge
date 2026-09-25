import { describe, expect, it, vi } from "vitest";

import type { StopRequest } from "./stop-source.ts";
import { createStopSource } from "./stop-source.ts";

const SIGINT: StopRequest = { signal: "SIGINT", type: "signal" };
const OWNER_GONE: StopRequest = { type: "owner_gone" };

describe(createStopSource, () => {
	it("should start with no request and a live signal", () => {
		expect.assertions(2);

		const stop = createStopSource();

		expect(stop.reason()).toBeUndefined();
		expect(stop.signal.aborted).toBeFalse();
	});

	it("should tell every listener and abort on the first request", () => {
		expect.assertions(3);

		const stop = createStopSource();
		const first = vi.fn<(request: StopRequest) => void>();
		const second = vi.fn<(request: StopRequest) => void>();
		stop.onStop(first);
		stop.onStop(second);
		stop.request(SIGINT);

		expect(first).toHaveBeenCalledExactlyOnceWith(SIGINT);
		expect(second).toHaveBeenCalledExactlyOnceWith(SIGINT);
		expect(stop.signal.aborted).toBeTrue();
	});

	it("should keep the first request and ignore later ones", () => {
		expect.assertions(2);

		const stop = createStopSource();
		const listener = vi.fn<(request: StopRequest) => void>();
		stop.onStop(listener);
		stop.request(OWNER_GONE);
		stop.request(SIGINT);

		expect(stop.reason()).toStrictEqual(OWNER_GONE);
		expect(listener).toHaveBeenCalledExactlyOnceWith(OWNER_GONE);
	});

	it("should tell a listener added after the request at once", () => {
		expect.assertions(1);

		const stop = createStopSource();
		stop.request(OWNER_GONE);
		const listener = vi.fn<(request: StopRequest) => void>();
		const dispose = stop.onStop(listener);
		dispose();

		expect(listener).toHaveBeenCalledExactlyOnceWith(OWNER_GONE);
	});

	it("should not tell a removed listener", () => {
		expect.assertions(1);

		const stop = createStopSource();
		const listener = vi.fn<(request: StopRequest) => void>();
		stop.onStop(listener)();
		stop.request(SIGINT);

		expect(listener).not.toHaveBeenCalled();
	});

	it("should hurry on a forced shutdown, also after an earlier request", () => {
		expect.assertions(3);

		const stop = createStopSource();
		stop.request(SIGINT);

		expect(stop.hurry.aborted).toBeFalse();

		stop.request({ force: true, type: "shutdown" });

		expect(stop.hurry.aborted).toBeTrue();
		expect(stop.reason()).toStrictEqual(SIGINT);
	});

	it("should not hurry on a shutdown that is not forced", () => {
		expect.assertions(1);

		const stop = createStopSource();
		stop.request({ type: "shutdown" });

		expect(stop.hurry.aborted).toBeFalse();
	});
});
