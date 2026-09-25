import type { PartialStrykerOptions } from "@stryker-mutator/api/core";

export default {
	checkers: ["typescript"],
	concurrency: "75%",
	coverageAnalysis: "perTest",
	disableTypeChecks: false,
	htmlReporter: { fileName: "reports/mutation/index.html" },
	ignorePatterns: [
		".agents",
		// Skill symlinks; copying them into the sandbox fails on Windows.
		".claude",
		".eslintcache*",
		".tmp",
		"coverage",
		"dist",
		"out-tsc",
		"reaper",
		"reports",
	],
	ignoreStatic: true,
	incremental: true,
	incrementalFile: "reports/stryker-incremental.json",
	mutate: [
		"src/**/*.ts",
		"!src/**/*.spec.ts",
		"!src/**/*.spec-d.ts",
		"!src/**/*.d.ts",
		"!src/cli.ts",
	],
	plugins: ["@stryker-mutator/vitest-runner", "@stryker-mutator/typescript-checker"],
	reporters: ["html", "clear-text", "progress"],
	testRunner: "vitest",
	// The floor only moves up.
	thresholds: { break: 100, high: 100, low: 100 },
	tsconfigFile: "tsconfig.lib.json",
	vitest: { configFile: "vitest.stryker.config.ts" },
} satisfies PartialStrykerOptions;
