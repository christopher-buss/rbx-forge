import { describe, expect, it } from "vitest";

import type { MutationDependencies, Report, StrykerExit } from "./mutation.ts";
import { classifyExit, countMutants, runMutation, shouldPublish } from "./mutation.ts";

const SHARED = "/repo/.git/stryker/incremental.json";
const LOCAL = "reports/stryker-incremental.json";

function report(mutants: number, complete: "absent" | boolean = "absent"): string {
	const files = { "src/a.ts": { mutants: Array.from({ length: mutants }, (_, id) => ({ id })) } };
	return JSON.stringify(complete === "absent" ? { files } : { complete, files });
}

function fake(exit: StrykerExit, initial: Record<string, string> = {}) {
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
			read: (file) => files.get(file),
			rename: (from, to) => {
				files.set(to, files.get(from) ?? "");
				files.delete(from);
			},
			write: (file, contents) => {
				files.set(file, contents);
			},
		},
		localFile: LOCAL,
		run: () => {
			order.push("run");
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

function parsed(mutants: number): Report {
	return { files: { "src/a.ts": { mutants: Array.from({ length: mutants }) } } };
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

		expect(shouldPublish("complete", parsed(1), report(5, true))).toBeTrue();
	});

	it("should never publish a failed run", () => {
		expect.assertions(1);

		expect(shouldPublish("failed", parsed(1), undefined)).toBeFalse();
	});

	it("should publish a partial run when no shared report exists", () => {
		expect.assertions(1);

		expect(shouldPublish("partial", parsed(1), undefined)).toBeTrue();
	});

	it("should publish a partial run over a malformed shared report", () => {
		expect.assertions(2);

		expect(shouldPublish("partial", parsed(1), "{")).toBeTrue();
		expect(shouldPublish("partial", parsed(1), "{}")).toBeTrue();
	});

	it("should keep a complete shared report over a partial run", () => {
		expect.assertions(1);

		expect(shouldPublish("partial", parsed(9), report(1, true))).toBeFalse();
	});

	it("should replace a smaller partial shared report with a partial run", () => {
		expect.assertions(3);

		expect(shouldPublish("partial", parsed(3), report(2, false))).toBeTrue();
		expect(shouldPublish("partial", parsed(3), report(2))).toBeTrue();
		expect(shouldPublish("partial", parsed(2), report(2, false))).toBeFalse();
	});
});

describe(runMutation, () => {
	it("should seed the local report from the shared one before Stryker runs", () => {
		expect.assertions(2);

		const { dependencies, files, order } = fake({ code: 0 }, { [SHARED]: report(4, true) });
		runMutation(dependencies);

		expect(order.slice(0, 3)).toStrictEqual([
			"mkdir reports",
			`copy ${SHARED} ${LOCAL}`,
			"run",
		]);
		expect(files.get(LOCAL)).toBe(report(4, true));
	});

	it("should publish a complete run marked complete and return Stryker's code", () => {
		expect.assertions(3);

		const { dependencies, files, order, shared } = fake({ code: 1 });
		dependencies.run = () => {
			files.set(LOCAL, report(2));
			return { code: 1 };
		};

		expect(runMutation(dependencies)).toBe(1);
		expect(shared()).toStrictEqual({
			complete: true,
			files: { "src/a.ts": { mutants: [{ id: 0 }, { id: 1 }] } },
		});
		expect(order).toContain("mkdir /repo/.git/stryker");
	});

	it("should publish a partial run marked partial", () => {
		expect.assertions(2);

		const { dependencies, files, shared } = fake({ code: 130 });
		dependencies.run = () => {
			files.set(LOCAL, report(2));
			return { code: 130 };
		};

		expect(runMutation(dependencies)).toBe(130);
		expect(shared()).toMatchObject({ complete: false });
	});

	it("should leave the shared report alone when Stryker fails", () => {
		expect.assertions(2);

		const { dependencies, files } = fake({ code: 2 }, { [SHARED]: report(1, true) });
		files.set(LOCAL, report(5));

		expect(runMutation(dependencies)).toBe(2);
		expect(files.get(SHARED)).toBe(report(1, true));
	});

	it("should publish nothing when the local report is malformed", () => {
		expect.assertions(1);

		const { dependencies, files } = fake({ code: 0 }, { [LOCAL]: "{" });
		runMutation(dependencies);

		expect(files.has(SHARED)).toBeFalse();
	});

	it("should publish nothing when Stryker wrote no report", () => {
		expect.assertions(2);

		const { dependencies, files } = fake({ code: null });

		expect(runMutation(dependencies)).toBe(1);
		expect(files.has(SHARED)).toBeFalse();
	});
});
