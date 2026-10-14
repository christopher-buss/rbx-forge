import { GLOB_SRC, GLOB_TESTS, isentinel } from "@isentinel/eslint-config";

const PLUGIN_SRC = `plugin/src/${GLOB_SRC}`;
const PLUGIN_TESTS = GLOB_TESTS.map((glob) => `plugin/src/${glob}`);
const NODE_TESTS = ["src", "scripts", "test"].flatMap((directory) => {
	return GLOB_TESTS.map((glob) => `${directory}/${glob}`);
});

export default isentinel(
	{
		name: "project/root",
		flawless: true,
		ignores: [
			"skills-lock.json",
			"reaper/target/**",
			".tmp/**",
			"reports/**",
			".agents/**",
			".claude/**",
			"plugin/{build,include,out,.jest-roblox}/**",
		],
		namedConfigs: true,
		naming: true,
		oxlint: "native",
		pnpm: true,
		roblox: { files: [PLUGIN_SRC], filesTypeAware: [PLUGIN_SRC] },
		test: {
			jest: { extended: true, files: PLUGIN_TESTS },
			vitest: { extended: true, files: NODE_TESTS, typecheck: true },
		},
		type: "package",
		typescript: {
			parserOptionsTypeAware: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	{
		// Process entries, like `src/cli.ts`: the config exempts that one by
		// name.
		name: "project/process-entries",
		files: ["src/supervisor.ts", "scripts/worktree/{create,remove}.ts"],
		rules: { "antfu/no-top-level-await": "off" },
	},
	{
		name: "project/type-tests",
		files: ["**/*.spec-d.ts"],
		rules: { "flawless/max-lines-per-function": "off" },
	},
	{
		name: "project/no-module-mocks",
		files: ["**/*.spec.ts", "test/**/*.ts"],
		ignores: ["**/*.d.ts"],
		rules: {
			"no-restricted-syntax": [
				"error",
				"[declare=true]",
				"TSEnumDeclaration[const=true]",
				"TSExportAssignment",
				{
					message: "vi.mock is banned; inject the dependency instead.",
					selector:
						"CallExpression[callee.object.name='vi'][callee.property.name=/^(do)?[mM]ock$/]",
				},
			],
		},
	},
);
