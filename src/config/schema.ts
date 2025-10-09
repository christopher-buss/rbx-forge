import { type } from "arktype";

export const configSchema = type({
	"buildOutputPath?": "string",
	"commandNames?": {
		"build?": "string",
		"init?": "string",
		"serve?": "string",
	},
	"projectType": "'rbxts' | 'luau'",
});

export type Config = typeof configSchema.infer;
