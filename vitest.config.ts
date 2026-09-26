import type { TestProjectInlineConfiguration } from "vitest/config";
import { defaultExclude, defineConfig } from "vitest/config";

const setupFiles = ["./test/setup/jest-extended.ts"];

/**
 * The coverage-measured suite. Never spawns a process: every I/O goes through
 * injected seams. `vitest.stryker.config.ts` runs the same project.
 */
export const unitProject = {
	extends: true,
	test: {
		name: "unit",
		clearMocks: true,
		exclude: [...defaultExclude, "./src/cli.ts", "./src/supervisor.ts"],
		include: ["src/**/*.spec.ts"],
		// `vi.mock` is banned (lint), so no spec needs a fresh module graph.
		isolate: false,
		restoreMocks: true,
		setupFiles,
		typecheck: {
			// TS7 through the `@typescript/native` alias; its bin is `tsc`.
			checker: "tsc",
			enabled: true,
			include: ["src/**/*.spec-d.ts"],
			tsconfig: "./tsconfig.spec.json",
		},
		unstubEnvs: true,
	},
} satisfies TestProjectInlineConfiguration;

export default defineConfig({
	test: {
		coverage: {
			exclude: ["src/cli.ts", "src/supervisor.ts", "src/**/*.spec-d.ts"],
			include: ["src/**/*.ts"],
			thresholds: {
				branches: 100,
				functions: 100,
				lines: 100,
				statements: 100,
			},
		},
		projects: [
			unitProject,
			{
				extends: true,
				test: {
					name: "integration",
					clearMocks: true,
					// A supervisor's stop, then a kill (`session-harness.ts`).
					hookTimeout: 30_000,
					include: ["test/integration/**/*.spec.ts"],
					restoreMocks: true,
					setupFiles,
					// Real processes; Windows spawns are slow under load.
					testTimeout: 15_000,
					unstubEnvs: true,
				},
			},
			{
				extends: true,
				test: {
					name: "e2e",
					clearMocks: true,
					// Removing temp projects outruns the default on Windows.
					hookTimeout: 30_000,
					include: ["test/e2e/**/*.spec.ts"],
					restoreMocks: true,
					setupFiles: [...setupFiles, "./test/setup/studio-isolation.ts"],
					testTimeout: 60_000,
					unstubEnvs: true,
				},
			},
			{
				extends: true,
				test: {
					// CI only: it needs a second local user (`other-user` job).
					name: "other-user",
					clearMocks: true,
					include: ["test/other-user/**/*.spec.ts"],
					restoreMocks: true,
					setupFiles,
					testTimeout: 30_000,
					unstubEnvs: true,
				},
			},
		],
		watch: false,
	},
});
