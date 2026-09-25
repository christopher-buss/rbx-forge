import { fromAny } from "@total-typescript/shoehorn";

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { createSignals, STOP_SIGNALS } from "./signals.ts";

describe(createSignals, () => {
	it("should call the listener for every stop signal until it is removed", () => {
		expect.assertions(2);

		const source = new EventEmitter();
		const listener = vi.fn<(signal: NodeJS.Signals) => void>();
		const remove = createSignals(fromAny(source)).onStop(listener);
		for (const signal of STOP_SIGNALS) {
			source.emit(signal, signal);
		}

		remove();
		source.emit("SIGTERM", "SIGTERM");

		expect(listener.mock.calls).toStrictEqual([
			["SIGBREAK"],
			["SIGHUP"],
			["SIGINT"],
			["SIGTERM"],
		]);
		expect(source.eventNames()).toStrictEqual([]);
	});
});
