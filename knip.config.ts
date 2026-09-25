import type { KnipConfig } from "knip";

export default {
	entry: [
		// Fixture binaries run as processes, never imported.
		"test/fixtures/bin/*.ts",
	],
	ignore: [".agents/**"],
	ignoreDependencies: [
		// Ambient lib replacement through `libReplacement`.
		"better-typescript-lib",
		// Peers loaded by @isentinel/eslint-config and isentinel-lint.
		"eslint-plugin-pnpm",
		// Editor-only daemon.
		"eslint_d",
	],
	stryker: { config: ["stryker.config.ts"] },
	vitest: { config: ["vitest{,.stryker}.config.ts"] },
} satisfies KnipConfig;
