import type { ResolvedConfig } from "./schema";

export const defaults: ResolvedConfig = {
	buildOutputPath: "game.rbxl",
	commandNames: {
		build: "forge:build",
		compile: "forge:compile",
		init: "init",
		open: "forge:open",
		serve: "forge:serve",
		start: "forge:start",
		watch: "forge:watch",
	},
	luau: {
		watch: {
			args: [],
			command: "",
		},
	},
	projectType: "rbxts",
	rbxts: {
		args: ["--verbose"],
		command: "rbxtsc",
		watchOnOpen: true,
	},
};
