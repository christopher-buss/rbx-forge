import type {
	Lease,
	LeaseReport,
	LeaseRequest,
	MachineBudget,
	TreePeaks,
} from "@isentinel/machine-budget";

import assert from "node:assert";
import { EventEmitter } from "node:events";
import { describe, it, vi } from "vitest";

import type { ChildExit, StrykerChild } from "./adaptive.ts";
import {
	buildLeaseReport,
	buildStrykerLeaseRequest,
	describePeaks,
	maxStrykerWorkers,
	parseCapacityApplied,
	runAdaptiveStrykerAsync,
	setCapacityMessage,
	startTicking,
	workersToGrow,
} from "./adaptive.ts";

interface FakeLease {
	readonly lease: Lease;
	readonly reports: Array<LeaseReport | undefined>;
}

interface FakeBudget {
	readonly budget: MachineBudget;
	readonly requests: Array<{ kind: string; request: LeaseRequest }>;
}

interface Harness {
	cancelled: boolean;
	readonly child: FakeChild;
	readonly env: Array<Record<string, string>>;
	readonly lines: Array<string>;
	run: Promise<ChildExit>;
	readonly tick: () => void;
	readonly watched: Array<number>;
}

class FakeChild extends EventEmitter implements StrykerChild {
	public readonly pid: number | undefined;
	public readonly sent: Array<unknown> = [];

	constructor(pid: number | undefined) {
		super();
		this.pid = pid;
	}

	public send(message: unknown, callback: (error: Error | null) => void): boolean {
		this.sent.push(message);
		callback(new Error("channel closed"));
		return true;
	}
}

function fakeLease(workers: number): FakeLease {
	const reports: Array<LeaseReport | undefined> = [];
	return {
		lease: {
			memoryPerWorker: 1,
			release: (report) => {
				reports.push(report);
			},
			workers,
		},
		reports,
	};
}

function fakeBudget(options: {
	cap: number;
	first: FakeLease;
	grown: Array<FakeLease | undefined>;
}): FakeBudget {
	const requests: Array<{ kind: string; request: LeaseRequest }> = [];
	const grown = [...options.grown];
	return {
		budget: {
			close: () => {},
			isShared: true,
			leaseAsync: async (request) => {
				requests.push({ kind: "leaseAsync", request });
				return options.first.lease;
			},
			runCapWorkers: () => options.cap,
			tryLease: (request) => {
				requests.push({ kind: "tryLease", request });
				return grown.shift()?.lease;
			},
		},
		requests,
	};
}

function startHarness(options: {
	budget: MachineBudget;
	peaks?: TreePeaks;
	pid?: number | undefined;
}): Harness {
	const child = new FakeChild("pid" in options ? options.pid : 4242);
	let tick: (() => void) | undefined;
	const harness: Harness = {
		cancelled: false,
		child,
		env: [],
		lines: [],
		run: Promise.resolve({ code: null, signal: null }),
		tick: () => tick?.(),
		watched: [],
	};
	harness.run = runAdaptiveStrykerAsync({
		budget: options.budget,
		log: (line) => {
			harness.lines.push(line);
		},
		parallelism: 8,
		project: "rbx-forge",
		schedule: (next) => {
			tick = next;
			return () => {
				harness.cancelled = true;
			};
		},
		spawn: (environment) => {
			harness.env.push(environment);
			return child;
		},
		watchTree: (pid) => {
			harness.watched.push(pid);
			return {
				stop: () => options.peaks ?? { peakMemory: undefined, peakPerWorker: undefined },
			};
		},
	});
	return harness;
}

function isTimer(value: unknown): value is NodeJS.Timeout {
	return typeof value === "object" && value !== null && "hasRef" in value;
}

async function settleAsync(): Promise<void> {
	await new Promise((resolve) => {
		setImmediate(resolve);
	});
}

const MIB = 1024 * 1024;

const REQUEST: LeaseRequest = {
	cost: { pass: "stryker", project: "rbx-forge" },
	isMainLaneOnly: true,
	maxWorkers: 7,
	memoryPerWorker: 1024 * MIB,
	minWorkers: 2,
};

describe(maxStrykerWorkers, () => {
	it.for([
		{ expected: 2, parallelism: 1 },
		{ expected: 2, parallelism: 3 },
		{ expected: 3, parallelism: 4 },
		{ expected: 15, parallelism: 16 },
	])(
		"should allow $parallelism logical cores to use $expected workers",
		({ expected, parallelism }, { expect }) => {
			expect.assertions(1);

			expect(maxStrykerWorkers(parallelism)).toBe(expected);
		},
	);
});

describe(buildStrykerLeaseRequest, () => {
	it("should ask for a checker and a test runner up to the core limit at 1 GiB each", ({
		expect,
	}) => {
		expect.assertions(1);

		expect(buildStrykerLeaseRequest({ parallelism: 8, project: "rbx-forge" })).toStrictEqual(
			REQUEST,
		);
	});
});

describe(workersToGrow, () => {
	it.for([
		{ cap: 8, expected: 4, held: 3, max: 7 },
		{ cap: 5, expected: 2, held: 3, max: 7 },
		{ cap: 3, expected: 0, held: 3, max: 7 },
		{ cap: 2, expected: 0, held: 3, max: 7 },
	])(
		"should grow $expected workers when $held are held under a cap of $cap",
		({ cap, expected, held, max }, { expect }) => {
			expect.assertions(1);

			expect(workersToGrow({ cap, held, max })).toBe(expected);
		},
	);
});

describe(buildLeaseReport, () => {
	it("should report both peaks when the platform reads them", ({ expect }) => {
		expect.assertions(1);

		expect(buildLeaseReport({ peakMemory: 900, peakPerWorker: 300 })).toStrictEqual({
			peakMemory: 900,
			peakPerWorker: 300,
		});
	});

	it("should leave out the worker peak when only the tree peak is known", ({ expect }) => {
		expect.assertions(1);

		expect(buildLeaseReport({ peakMemory: 900, peakPerWorker: undefined })).toStrictEqual({
			peakMemory: 900,
		});
	});

	it("should report nothing when the tree peak is unknown", ({ expect }) => {
		expect.assertions(1);

		expect(buildLeaseReport({ peakMemory: undefined, peakPerWorker: 300 })).toBeUndefined();
	});
});

describe(describePeaks, () => {
	it("should give both peaks in whole MiB", ({ expect }) => {
		expect.assertions(1);

		expect(describePeaks({ peakMemory: 3000.4 * MIB, peakPerWorker: 899.6 * MIB })).toBe(
			"peak 3000 MiB, 900 MiB per worker",
		);
	});

	it("should name an unknown worker peak", ({ expect }) => {
		expect.assertions(1);

		expect(describePeaks({ peakMemory: MIB })).toBe("peak 1 MiB, unknown per worker");
	});
});

describe(setCapacityMessage, () => {
	it("should build the resize message the patched Stryker reads", ({ expect }) => {
		expect.assertions(1);

		expect(setCapacityMessage(5)).toStrictEqual({ capacity: 5, type: "stryker:set-capacity" });
	});
});

describe(parseCapacityApplied, () => {
	it("should read the capacity Stryker applied", ({ expect }) => {
		expect.assertions(1);

		expect(parseCapacityApplied({ capacity: 4, type: "stryker:capacity-applied" })).toBe(4);
	});

	it.for([
		["another type", { capacity: 4, type: "stryker:set-capacity" }],
		["a text capacity", { capacity: "4", type: "stryker:capacity-applied" }],
		["no capacity", { type: "stryker:capacity-applied" }],
		["no type", { capacity: 4 }],
		["no object", "stryker:capacity-applied"],
		["nothing", undefined],
		["null", JSON.parse("null")],
	])("should ignore %s", ([, message], { expect }) => {
		expect.assertions(1);

		expect(parseCapacityApplied(message)).toBeUndefined();
	});
});

describe(runAdaptiveStrykerAsync, () => {
	it("should spawn Stryker with the leased workers and watch its tree", async ({ expect }) => {
		expect.assertions(3);

		const { budget, requests } = fakeBudget({ cap: 3, first: fakeLease(3), grown: [] });
		const harness = startHarness({ budget });
		await settleAsync();
		harness.child.emit("exit", 0, null);
		await harness.run;

		expect(requests).toStrictEqual([{ kind: "leaseAsync", request: REQUEST }]);
		expect(harness.env).toStrictEqual([{ STRYKER_ADAPTIVE_INITIAL_CAPACITY: "3" }]);
		expect(harness.watched).toStrictEqual([4242]);
	});

	it("should grow the run and send each new capacity while the run cap allows", async ({
		expect,
	}) => {
		expect.assertions(3);

		const { budget, requests } = fakeBudget({
			cap: 6,
			first: fakeLease(2),
			grown: [fakeLease(2), undefined],
		});
		const harness = startHarness({ budget });
		await settleAsync();
		harness.tick();
		harness.tick();
		harness.tick();
		harness.child.emit("exit", 0, null);
		await harness.run;

		expect(requests.slice(1)).toStrictEqual([
			{ kind: "tryLease", request: { ...REQUEST, maxWorkers: 4, minWorkers: 1 } },
			{ kind: "tryLease", request: { ...REQUEST, maxWorkers: 2, minWorkers: 1 } },
			{ kind: "tryLease", request: { ...REQUEST, maxWorkers: 2, minWorkers: 1 } },
		]);
		expect(harness.child.sent).toStrictEqual([{ capacity: 4, type: "stryker:set-capacity" }]);
		expect(harness.lines).toContain("stryker: growing rbx-forge to 4 worker(s)");
	});

	it("should not ask for more workers once the run reaches its cap", async ({ expect }) => {
		expect.assertions(1);

		const { budget, requests } = fakeBudget({ cap: 9, first: fakeLease(7), grown: [] });
		const harness = startHarness({ budget });
		await settleAsync();
		harness.tick();
		harness.child.emit("exit", 0, null);
		await harness.run;

		expect(requests.map(({ kind }) => kind)).toStrictEqual(["leaseAsync"]);
	});

	it("should log the capacity Stryker reports it applied", async ({ expect }) => {
		expect.assertions(1);

		const { budget } = fakeBudget({ cap: 2, first: fakeLease(2), grown: [] });
		const harness = startHarness({ budget });
		await settleAsync();
		harness.child.emit("message", { capacity: 2, type: "stryker:capacity-applied" });
		harness.child.emit("message", { type: "other" });
		harness.child.emit("exit", 0, null);
		await harness.run;

		expect(harness.lines).toStrictEqual([
			"stryker: leased 2 worker(s) for rbx-forge",
			"stryker: rbx-forge runs 2 worker(s)",
		]);
	});

	it("should report the tree peaks once and release every lease on exit", async ({ expect }) => {
		expect.assertions(5);

		const first = fakeLease(2);
		const second = fakeLease(1);
		const { budget } = fakeBudget({ cap: 3, first, grown: [second] });
		const harness = startHarness({
			budget,
			peaks: { peakMemory: 3000 * MIB, peakPerWorker: 900 * MIB },
		});
		await settleAsync();
		harness.tick();
		harness.child.emit("exit", 7, null);

		await expect(harness.run).resolves.toStrictEqual({ code: 7, signal: null });
		expect(first.reports).toStrictEqual([{ peakMemory: 3000 * MIB, peakPerWorker: 900 * MIB }]);
		expect(harness.lines).toContain("stryker: rbx-forge peak 3000 MiB, 900 MiB per worker");
		expect(second.reports).toStrictEqual([undefined]);
		expect(harness.cancelled).toBeTrue();
	});

	it("should release without a report when the platform reads no peaks", async ({ expect }) => {
		expect.assertions(2);

		const first = fakeLease(2);
		const { budget } = fakeBudget({ cap: 2, first, grown: [] });
		const harness = startHarness({ budget });
		await settleAsync();
		harness.child.emit("exit", 0, null);
		await harness.run;

		expect(first.reports).toStrictEqual([undefined]);
		expect(harness.lines).toStrictEqual(["stryker: leased 2 worker(s) for rbx-forge"]);
	});

	it("should pass on the signal that ended Stryker", async ({ expect }) => {
		expect.assertions(1);

		const { budget } = fakeBudget({ cap: 2, first: fakeLease(2), grown: [] });
		const harness = startHarness({ budget });
		await settleAsync();
		harness.child.emit("exit", null, "SIGINT");

		await expect(harness.run).resolves.toStrictEqual({ code: null, signal: "SIGINT" });
	});

	it("should release the lease and report no exit when Stryker fails to start", async ({
		expect,
	}) => {
		expect.assertions(3);

		const first = fakeLease(2);
		const { budget } = fakeBudget({ cap: 2, first, grown: [] });
		const harness = startHarness({ budget, pid: undefined });
		await settleAsync();
		harness.child.emit("error", new Error("spawn failed"));

		await expect(harness.run).resolves.toStrictEqual({ code: null, signal: null });
		expect(harness.watched).toStrictEqual([]);
		expect(first.reports).toStrictEqual([undefined]);
	});
});

describe(startTicking, () => {
	it("should not keep the process alive", ({ expect }) => {
		expect.assertions(1);

		const created = vi.spyOn(globalThis, "setInterval");
		const cancel = startTicking(() => {}, 60_000);
		const timer: unknown = created.mock.results[0]!.value;
		cancel();
		assert(isTimer(timer));

		expect(timer.hasRef()).toBeFalse();
	});

	it("should call the tick on each interval until cancelled", ({ expect }) => {
		expect.assertions(2);

		vi.useFakeTimers();
		const tick = vi.fn<() => void>();
		const cancel = startTicking(tick, 500);
		vi.advanceTimersByTime(1000);
		const ticksBeforeCancel = tick.mock.calls.length;
		cancel();
		vi.advanceTimersByTime(1000);
		vi.useRealTimers();

		expect(ticksBeforeCancel).toBe(2);
		expect(tick).toHaveBeenCalledTimes(2);
	});
});
