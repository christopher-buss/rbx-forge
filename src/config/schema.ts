import { type } from "arktype";

export const configSchema = type({
	"buildOutputPath?": "string",
	"projectType": "'rbxts' | 'luau'",
});

export type Config = typeof configSchema.infer;
