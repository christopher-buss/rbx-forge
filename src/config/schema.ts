import { type } from "arktype";

export const configSchema = type({
	"buildOutputPath?": "string",
	"commandNames?": {
		"build?": "string",
		"compile?": "string",
		"init?": "string",
		"serve?": "string",
	},
	"projectType": "'rbxts' | 'luau'",
	"rbxtscArgs?": "string[]",
});

export type Config = typeof configSchema.infer;
