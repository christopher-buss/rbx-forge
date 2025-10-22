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
});

export type Config = typeof configSchema.infer;
export type ResolvedConfig = RequiredDeep<Config>;
