import { defineConfig } from "@isentinel/jest-roblox";

export default defineConfig({
	backend: "studio-cli",
	placeFile: "test.rbxl",
	rojoProject: "test.project.json",
	test: {
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
