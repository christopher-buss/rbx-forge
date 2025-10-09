import { log } from "@clack/prompts";

import { updateConfig } from "c12/update";
import dedent from "dedent";

import type { Config } from "./schema";

export async function createProjectConfig(projectType: Config["projectType"]): Promise<void> {
	await updateConfig({
		configFile: "rbx-forge.config",
		createExtension: ".ts",
		cwd: ".",
		onCreate: ({ configFile: filePath }) => {
			log.info(`Creating new config file: ${filePath}`);
			return dedent`
				import { defineConfig } from "rbx-forge";

				export default defineConfig({
				  projectType: "${projectType}",
				});
			`;
		},
	});
}
