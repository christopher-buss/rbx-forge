import { describe, expect, it, vi } from "vitest";

import { createFakeSignals } from "../../test/helpers/fake-reaper.ts";
import {
	createCommandContext,
	createRecordingReporter,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import { ForgeError } from "../errors.ts";
import type { CommandResult } from "../seams/reporter.ts";
import type { SupervisorLaunch, SupervisorLauncher } from "../supervisor/launcher.ts";
import { runStartAsync, START_FLAGS } from "./start.ts";

function startWith(flags: Record<string, boolean> = {}) {
	const signals = createFakeSignals();
	const reporter = createRecordingReporter();
	const result = Promise.withResolvers<CommandResult>();
	const stop = vi.fn<(signal: NodeJS.Signals) => void>();
	const launches: Array<SupervisorLaunch> = [];
	const supervisor = vi.fn<SupervisorLauncher>((launch) => {
		launches.push(launch);
		return { result: result.promise, stop };
	});
	const running = runStartAsync(
		createCommandContext({
			env: { PATH: "/bin" },
			reporter,
			seams: createTestSeams({ signals: signals.signals, supervisor }),
		}),
		{ config: { rojoPort: 5000 }, flags },
	);
	return { launches, reporter, result, running, signals, stop };
}

describe(runStartAsync, () => {
	it("should read --syncback into syncback.runOnStart", () => {
		expect.assertions(1);

		expect(START_FLAGS).toContainEqual(
			expect.objectContaining({ name: "syncback", config: "syncback.runOnStart" }),
		);
	});

	it("should launch the supervisor with the project, environment, and request", async () => {
		expect.assertions(2);

		const plain = startWith();
		const bare = startWith({ compiler: false, open: false });

		expect(plain.launches).toMatchObject([
			{
				cwd: PROJECT,
				env: { PATH: "/bin" },
				request: { compiler: true, config: { rojoPort: 5000 }, open: true },
			},
		]);
		expect(bare.launches[0]!.request).toMatchObject({ compiler: false, open: false });
	});

	it("should ask for forced cleanup of an earlier session only with --force", () => {
		expect.assertions(2);

		const forced = startWith({ force: true });
		const plain = startWith({ force: false });

		expect(forced.launches[0]!.request).toStrictEqual({
			compiler: true,
			config: { rojoPort: 5000 },
			force: true,
			open: true,
		});
		expect(plain.launches[0]!.request).toStrictEqual({
			compiler: true,
			config: { rojoPort: 5000 },
			open: true,
		});
	});

	it("should report the supervisor's events and return its result", async () => {
		expect.assertions(2);

		const { launches, reporter, result, running } = startWith();
		launches[0]!.onEvent({ message: "ready", type: "info" });
		result.resolve({ data: { reason: "SIGINT" }, summary: "Stopped." });

		await expect(running).resolves.toStrictEqual({
			data: { reason: "SIGINT" },
			summary: "Stopped.",
		});
		expect(reporter.events).toStrictEqual([{ message: "ready", type: "info" }]);
	});

	it("should pass stop signals on until the supervisor ends", async () => {
		expect.assertions(2);

		const { result, running, signals, stop } = startWith();
		signals.fire("SIGINT");
		result.reject(new ForgeError("session_running", "running"));

		await expect(running).rejects.toMatchObject({ code: "session_running" });
		expect([stop.mock.calls, signals.listeners()]).toStrictEqual([[["SIGINT"]], 0]);
	});
});
