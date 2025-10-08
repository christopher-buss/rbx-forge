import { log } from "@clack/prompts";

export const command = "build";
export const description = "Build the Rojo project";

export async function action(): Promise<void> {
	log.step("Building project...");
	// TODO: Implement Rojo build
	log.success("Build complete!");
}
