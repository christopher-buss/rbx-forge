import { log } from "@clack/prompts";

export const command = "init";
export const description = "Initialize a new rbxts-forge project";

export async function action(): Promise<void> {
	log.info("Initializing new project...");
	// TODO: Implement project initialization
	log.success("Project initialized!");
}
