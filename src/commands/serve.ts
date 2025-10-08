import { log } from "@clack/prompts";

export const command = "serve";
export const description = "Start the Rojo development server";

export async function action(): Promise<void> {
	log.step("Starting Rojo server...");
	// TODO: Implement Rojo serve
	log.info("Server running...");
}
