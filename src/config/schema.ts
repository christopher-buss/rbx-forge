import { type } from "arktype";
import type { RequiredDeep } from "type-fest";

export const configSchema = type({
	"buildOutputPath?": "string",
	"commandNames?": {
		"build?": "string",
		"compile?": "string",
		"init?": "string",
		"serve?": "string",
	},
	"projectType": "'rbxts' | 'luau'",
	"rbxts?": {
		"args?": "string[]",
		"command?": "string",
	},
});

export type Config = typeof configSchema.infer;
export type ResolvedConfig = RequiredDeep<Config>;
