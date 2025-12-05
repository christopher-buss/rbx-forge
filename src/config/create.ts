import { updateConfig } from "c12/update";
import dedent from "dedent";
import { CONFIG_FILE } from "src/constants";

import { logger } from "../utils/logger";
import type { Config } from "./schema";

export async function createProjectConfig(projectType: Config["projectType"]): Promise<void> {
	await updateConfig({
		configFile: CONFIG_FILE,
		createExtension: ".ts",
		cwd: ".",
		onCreate: ({ configFile: filePath }) => {
			logger.info(`Creating new config file: ${filePath}`);
			return dedent`
				import { defineConfig } from "rbx-forge";

				export default defineConfig({
				  projectType: "${projectType}",
				});
			`;
		},
	});
}
