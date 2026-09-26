import { isentinel } from "@isentinel/eslint-config";

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
		],
		namedConfigs: true,
		naming: true,
		oxlint: "native",
		pnpm: true,
		roblox: false,
		test: {
			vitest: { extended: true, typecheck: true },
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
		files: ["src/supervisor.ts"],
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
