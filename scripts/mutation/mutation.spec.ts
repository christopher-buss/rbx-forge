import { describe, expect, it } from "vitest";

import type { MutationDependencies, Report, StrykerExit } from "./mutation.ts";
import { classifyExit, countMutants, runMutation, shouldPublish } from "./mutation.ts";

const SHARED = "/repo/.git/stryker/incremental.json";
const LOCAL = "reports/stryker-incremental.json";

function reportOf(mutants: number): Report {
	return {
		files: { "src/a.ts": { mutants: Array.from({ length: mutants }, (_, id) => ({ id })) } },
	};
}

function reportJson(mutants: number, complete: "absent" | boolean = "absent"): string {
	const { files } = reportOf(mutants);
	return JSON.stringify(complete === "absent" ? { files } : { complete, files });
}

function fake(exit: StrykerExit, initial: Record<string, string> = {}, written?: string) {
	const files = new Map(Object.entries(initial));
	const order: Array<string> = [];
	const dependencies: MutationDependencies = {
		files: {
			copy: (from, to) => {
				order.push(`copy ${from} ${to}`);
				files.set(to, files.get(from) ?? "");
			},
			mkdir: (directory) => {
				order.push(`mkdir ${directory}`);
			},
			publish: (file, contents) => {
				files.set(file, contents);
			},
			read: (file) => files.get(file),
		},
		localFile: LOCAL,
		run: () => {
			order.push("run");
			if (written !== undefined) {
				files.set(LOCAL, written);
			}

			return exit;
		},
		sharedFile: SHARED,
	};
	return {
		dependencies,
		files,
		order,
		shared: (): unknown => JSON.parse(files.get(SHARED) ?? "null"),
	};
}

describe(classifyExit, () => {
	it("should count exit codes 0 and 1 as complete", () => {
		expect.assertions(2);

		expect(classifyExit({ code: 0 })).toBe("complete");
		expect(classifyExit({ code: 1 })).toBe("complete");
	});

	it("should count a signal exit as partial", () => {
		expect.assertions(2);

		expect(classifyExit({ code: 130 })).toBe("partial");
		expect(classifyExit({ code: null })).toBe("partial");
	});

	it("should count any other code as failed", () => {
		expect.assertions(2);

		expect(classifyExit({ code: 2 })).toBe("failed");
		expect(classifyExit({ code: 128 })).toBe("failed");
	});
});

describe(countMutants, () => {
	it("should count the mutants of every file", () => {
		expect.assertions(1);

		const files = { a: { mutants: [{}, {}] }, b: { mutants: [{}] } };

		expect(countMutants({ files })).toBe(3);
	});
});

describe(shouldPublish, () => {
	it("should always publish a complete run", () => {
		expect.assertions(1);

		expect(shouldPublish("complete", reportOf(1), reportJson(5, true))).toBeTrue();
	});

	it("should never publish a failed run", () => {
		expect.assertions(1);

		expect(shouldPublish("failed", reportOf(1), undefined)).toBeFalse();
	});

	it("should publish a partial run when no shared report exists", () => {
		expect.assertions(1);

		expect(shouldPublish("partial", reportOf(1), undefined)).toBeTrue();
	});

	it("should publish a partial run over a malformed shared report", () => {
		expect.assertions(2);

		expect(shouldPublish("partial", reportOf(1), "{")).toBeTrue();
		expect(shouldPublish("partial", reportOf(1), "{}")).toBeTrue();
	});

	it("should keep a complete shared report over a partial run", () => {
		expect.assertions(1);

		expect(shouldPublish("partial", reportOf(9), reportJson(1, true))).toBeFalse();
	});

	it("should replace a smaller partial shared report with a partial run", () => {
		expect.assertions(3);

		expect(shouldPublish("partial", reportOf(3), reportJson(2, false))).toBeTrue();
		expect(shouldPublish("partial", reportOf(3), reportJson(2))).toBeTrue();
		expect(shouldPublish("partial", reportOf(2), reportJson(2, false))).toBeFalse();
	});
});

describe(runMutation, () => {
	it("should seed the local report from the shared one before Stryker runs", () => {
		expect.assertions(2);

		const { dependencies, files, order } = fake({ code: 0 }, { [SHARED]: reportJson(4, true) });
		runMutation(dependencies);

		expect(order.slice(0, 3)).toStrictEqual([
			"mkdir reports",
			`copy ${SHARED} ${LOCAL}`,
			"run",
		]);
		expect(files.get(LOCAL)).toBe(reportJson(4, true));
	});

	it("should publish a complete run marked complete and return Stryker's code", () => {
		expect.assertions(3);

		const { dependencies, order, shared } = fake({ code: 1 }, {}, reportJson(2));

		expect(runMutation(dependencies)).toBe(1);
		expect(shared()).toStrictEqual({
			complete: true,
			files: { "src/a.ts": { mutants: [{ id: 0 }, { id: 1 }] } },
		});
		expect(order).toContain("mkdir /repo/.git/stryker");
	});

	it("should publish a partial run marked partial", () => {
		expect.assertions(2);

		const { dependencies, shared } = fake({ code: 130 }, {}, reportJson(2));

		expect(runMutation(dependencies)).toBe(130);
		expect(shared()).toMatchObject({ complete: false });
	});

	it("should leave the shared report alone when Stryker fails", () => {
		expect.assertions(2);

		const { dependencies, files } = fake(
			{ code: 2 },
			{ [SHARED]: reportJson(1, true) },
			reportJson(5),
		);

		expect(runMutation(dependencies)).toBe(2);
		expect(files.get(SHARED)).toBe(reportJson(1, true));
	});

	it("should publish nothing when the local report is malformed", () => {
		expect.assertions(1);

		const { dependencies, files } = fake({ code: 0 }, {}, "{");
		runMutation(dependencies);

		expect(files.has(SHARED)).toBeFalse();
	});

	it("should publish nothing when Stryker wrote no report", () => {
		expect.assertions(2);

		const { dependencies, files } = fake({ code: null });

		expect(runMutation(dependencies)).toBe(1);
		expect(files.has(SHARED)).toBeFalse();
	});

	it("should leave the shared report alone when a crash leaves the seed in place", () => {
		expect.assertions(2);

		const { dependencies, files } = fake({ code: 1 }, { [SHARED]: reportJson(3, false) });

		expect(runMutation(dependencies)).toBe(1);
		expect(files.get(SHARED)).toBe(reportJson(3, false));
	});

	it("should publish nothing when an interrupted run leaves a stale local report", () => {
		expect.assertions(2);

		const { dependencies, files } = fake({ code: 130 }, { [LOCAL]: reportJson(2) });

		expect(runMutation(dependencies)).toBe(130);
		expect(files.has(SHARED)).toBeFalse();
	});
});
