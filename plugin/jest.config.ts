import { defineConfig } from "@isentinel/jest-roblox";

export default defineConfig({
	backend: "studio-cli",
	placeFile: "test.rbxl",
	rojoProject: "test.project.json",
	test: {
		collectCoverage: true,
		coveragePathIgnorePatterns: ["**/main.server.ts"],
		coverageThreshold: {
			branches: 100,
			functions: 100,
			lines: 100,
			statements: 100,
		},
		projects: [
			{
				test: {
					displayName: "forge-plugin",
					include: ["src/**/*.spec.ts"],
					outDir: "out",
				},
			},
		],
	},
});
