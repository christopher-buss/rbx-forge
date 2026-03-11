import type { ResolvedConfig } from "./schema";

export const defaults: ResolvedConfig = {
	buildOutputPath: "game.rbxl",
	commandNames: {
		build: "forge:build",
		compile: "forge:compile",
		init: "init",
		open: "forge:open",
		restart: "forge:restart",
		serve: "forge:serve",
		start: "forge:start",
		stop: "forge:stop",
		syncback: "forge:syncback",
		typegen: "forge:typegen",
		watch: "forge:watch",
	},
	luau: {
		watch: {
			args: [],
			command: "",
		},
	},
	open: {
		buildFirst: true,
		buildOutputPath: undefined,
		projectPath: undefined,
	},
	projectType: "rbxts",
	rbxts: {
		args: ["--verbose"],
		command: "rbxtsc",
		watchOnOpen: false,
	},
	rojoAlias: "rojo",
	rojoProjectPath: "default.project.json",
	suppressNoTaskRunnerWarning: false,
	syncback: {
		projectPath: undefined,
		runOnStart: false,
	},
	syncbackInputPath: "game.rbxl",
	typegen: {
		exclude: ["**/node_modules/**"],
		include: ["**"],
		maxDepth: undefined,
	},
	typegenOutputPath: "src/services.d.ts",
};
