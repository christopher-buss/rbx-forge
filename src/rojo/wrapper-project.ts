import path from "node:path";

import type { CommandContext } from "../commands/context.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import { endpointKey } from "../supervisor/endpoint.ts";

/**
 * The generated project belongs to the session and only `rojo serve` uses it.
 *
 * @param directory - The session directory.
 * @returns Its generated wrapper project path.
 */
export function rojoWrapperPath(directory: string): string {
	return path.join(directory, "rojo.project.json");
}

/**
 * Write the worktree's Rojo identity around its original project tree.
 *
 * @param context - The project root and file system.
 * @param config - The original project and build output, for the endpoint key.
 * @param directory - The session directory.
 */
export function writeRojoWrapper(
	{ cwd, seams }: CommandContext,
	config: Pick<ResolvedConfig, "buildOutputPath" | "rojoProjectPath">,
	directory: string,
): void {
	const projectPath = path.resolve(cwd, config.rojoProjectPath);
	// Rojo validates the project; forge reads only its name and root serve
	// fields.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- project JSON has named fields
	const project = JSON.parse(seams.fileSystem.readFileSync(projectPath, "utf8")) as Record<
		string,
		unknown
	>;
	const wrapper: Record<string, unknown> = {
		name: `${String(project["name"])}@${endpointKey(cwd, config.buildOutputPath)}`,
		tree: { $path: projectPath },
	};
	// Rojo reads these fields from the root project only.
	for (const field of ["servePort", "serveAddress", "servePlaceIds", "placeId", "gameId"]) {
		if (Object.hasOwn(project, field)) {
			wrapper[field] = project[field];
		}
	}

	seams.fileSystem.writeFileSync(
		rojoWrapperPath(directory),
		`${JSON.stringify(wrapper, undefined, "\t")}\n`,
	);
}
