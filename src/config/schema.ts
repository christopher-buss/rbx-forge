import { type } from "arktype";
import type { RequiredDeep } from "type-fest";

export const configSchema = type({
	"buildOutputPath?": "string",
	"commandNames?": {
		"build?": "string",
		"compile?": "string",
		"init?": "string",
		"open?": "string",
		"serve?": "string",
		"start?": "string",
		"stop?": "string",
		"syncback?": "string",
		"typegen?": "string",
		"watch?": "string",
	},
	"luau?": {
		"watch?": {
			"args?": "string[]",
			"command?": "string",
		},
	},
	"projectType": "'rbxts' | 'luau'",
	"rbxts?": {
		"args?": "string[]",
		"command?": "string",
		"watchOnOpen?": "boolean",
	},
	"suppressNoTaskRunnerWarning?": "boolean",
	"syncback?": {
		"runOnStart?": "boolean",
	},
	"syncbackInputPath?": "string",
	"typegen?": {
		"exclude?": "string[]",
		"include?": "string[]",
		"maxDepth?": "number | undefined",
	},
	"typegenOutputPath?": "string",
});

export type Config = typeof configSchema.infer;
export type ResolvedConfig = RequiredDeep<Config>;
