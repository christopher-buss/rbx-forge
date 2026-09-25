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
		name: "project/package-json",
		files: ["package.json"],
		// CLI only until the config ticket adds the `defineConfig` library
		// entry and its types.
		rules: { "package-json/require-types": "off" },
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
