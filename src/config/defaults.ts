import type { Config } from "./schema";

export const defaults: Config = {
	buildOutputPath: "game.rbxl",
	commandNames: {
		build: "forge:build",
		init: "init",
		serve: "forge:serve",
	},
	projectType: "rbxts",
};
