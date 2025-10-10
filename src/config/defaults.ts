import type { ResolvedConfig } from "./schema";

export const defaults: ResolvedConfig = {
	buildOutputPath: "game.rbxl",
	commandNames: {
		build: "forge:build",
		compile: "forge:compile",
		init: "init",
		serve: "forge:serve",
	},
	projectType: "rbxts",
	rbxts: {
		args: ["--verbose"],
		command: "rbxtsc",
	},
};
