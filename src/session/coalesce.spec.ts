import { describe, expect, it } from "vitest";

import { createCoalescingRunner } from "./coalesce.ts";

interface Controlled {
	/** What happened, in order: `start 1`, `end 1`, ... */
	calls: Array<string>;
	/** End the run that is going. */
	finish: () => void;
	task: () => Promise<void>;
}

function controlledTask(): Controlled {
	const calls: Array<string> = [];
	const ends: Array<() => void> = [];
	let count = 0;
	return {
		calls,
		finish: () => {
			ends.shift()!();
		},
		task: async () => {
			count += 1;
			const run = count;
			calls.push(`start ${run}`);
			await new Promise<void>((resolve) => {
				ends.push(resolve);
			});
			calls.push(`end ${run}`);
		},
	};
}

async function flushAsync(): Promise<void> {
	await new Promise((resolve) => {
		setImmediate(resolve);
	});
}

describe(createCoalescingRunner, () => {
	it("should run at once when nothing runs", async () => {
		expect.assertions(1);

		const task = controlledTask();
		const runner = createCoalescingRunner(task.task);
		runner.request();
		await flushAsync();
		task.finish();
		await runner.settled();

		expect(task.calls).toStrictEqual(["start 1", "end 1"]);
	});

	it("should fold every request during a run into one more run after it", async () => {
		expect.assertions(1);

		const task = controlledTask();
		const runner = createCoalescingRunner(task.task);
		runner.request();
		runner.request();
		runner.request();
		await flushAsync();
		task.finish();
		await flushAsync();
		task.finish();
		await runner.settled();

		expect(task.calls).toStrictEqual(["start 1", "end 1", "start 2", "end 2"]);
	});

	it("should start a new run for a request after the runs settled", async () => {
		expect.assertions(1);

		const task = controlledTask();
		const runner = createCoalescingRunner(task.task);
		runner.request();
		await flushAsync();
		task.finish();
		await runner.settled();
		runner.request();
		await flushAsync();
		task.finish();
		await runner.settled();

		expect(task.calls).toStrictEqual(["start 1", "end 1", "start 2", "end 2"]);
	});

	it("should settle at once when nothing ran", async () => {
		expect.assertions(1);

		const runner = createCoalescingRunner(async () => {
			// Never runs.
		});

		await expect(runner.settled()).resolves.toBeUndefined();
	});
});
