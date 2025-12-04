import { type } from "arktype";
import { loadConfig } from "c12";
import process from "node:process";

import { logger } from "../utils/logger";
import { defaults } from "./defaults";
import { configSchema, type ResolvedConfig } from "./schema";

export async function loadProjectConfig(): Promise<ResolvedConfig> {
	const { config: rawConfig } = await loadConfig({
		defaults,
		name: "rbx-forge",
		packageJson: true,
	});

	const validated = configSchema(rawConfig);

	if (validated instanceof type.errors) {
		logger.error("Invalid configuration:");
		logger.error(validated.summary);
		process.exit(1);
	}

	return validated as ResolvedConfig;
}
