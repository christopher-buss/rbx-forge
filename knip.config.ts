import type { KnipConfig } from "knip";

export default {
	ignore: [".agents/**"],
	// External tools exercised by integration and opt-in Studio tests.
	ignoreBinaries: ["luau", "rojo"],
	// A type that annotates an export in its own file is part of that
	// export's declaration (`isolatedDeclarations` needs it exported).
	ignoreExportsUsedInFile: { interface: true, type: true },
	workspaces: {
		".": {
			entry: [
				// Fixture binaries run as processes, never imported.
				"test/fixtures/bin/*.ts",
				// Claude Code worktree hooks (`.claude/settings.json`).
				"scripts/worktree/{create,remove}.ts",
				// Release steps (`package.json` scripts).
				"scripts/release/{bootstrap,check,publish}.ts",
			],
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
		},
		"plugin": {
			// The plugin's Script, and the jest-roblox config.
			entry: ["src/main.server.ts", "jest.config.ts"],
			// Ambient roblox-ts types, and the Jest runtime the specs run in.
			ignoreDependencies: ["@rbxts/compiler-types", "@rbxts/jest"],
		},
	},
} satisfies KnipConfig;
