import type { KnipConfig } from "knip";

export default {
	entry: [
		// Fixture binaries run as processes, never imported.
		"test/fixtures/bin/*.ts",
	],
	ignore: [".agents/**"],
	// Windows tools the opt-in real Studio test runs.
	ignoreBinaries: ["tasklist"],
	ignoreDependencies: [
		// Ambient lib replacement through `libReplacement`.
		"better-typescript-lib",
		// Peers loaded by @isentinel/eslint-config and isentinel-lint.
		"eslint-plugin-pnpm",
		// Editor-only daemon.
		"eslint_d",
	],
	// A type that annotates an export in its own file is part of that
	// export's declaration (`isolatedDeclarations` needs it exported).
	ignoreExportsUsedInFile: { interface: true, type: true },
	stryker: { config: ["stryker.config.ts"] },
	vitest: { config: ["vitest{,.stryker}.config.ts"] },
} satisfies KnipConfig;
