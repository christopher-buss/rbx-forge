import path from "node:path";
import stripJsonComments from "strip-json-comments";

import type { CommandContext } from "../commands/context.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import { endpointKey } from "../supervisor/endpoint.ts";

const PROJECT_SUFFIX = /\.project\.jsonc?$/u;

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
	const content = stripJsonComments(seams.fileSystem.readFileSync(projectPath, "utf8"), {
		trailingCommas: true,
	});
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Rojo validates the project shape
	const project = JSON.parse(content) as Record<string, unknown> & { name?: string };
	const wrapper: Record<string, unknown> = {
		name: `${project.name ?? inferProjectName(projectPath)}@${endpointKey(cwd, config.buildOutputPath)}`,
		tree: { $path: projectPath },
	};
	// Rojo reads these fields from the root project only.
	for (const field of ["servePort", "serveAddress", "servePlaceIds", "placeId", "gameId"]) {
		// Stryker disable next-line ConditionalExpression: JSON drops undefined
		if (Object.hasOwn(project, field)) {
			wrapper[field] = project[field];
		}
	}

	seams.fileSystem.writeFileSync(
		rojoWrapperPath(directory),
		// Stryker disable next-line StringLiteral: equivalent formatting
		`${JSON.stringify(wrapper, undefined, "\t")}\n`,
	);
}

/**
 * Match Rojo's default-project folder name and named-project filename stem.
 *
 * @param projectPath - The absolute user project path.
 * @returns The inferred project name.
 */
function inferProjectName(projectPath: string): string {
	const filename = path.basename(projectPath);
	return filename === "default.project.json" || filename === "default.project.jsonc"
		? path.basename(path.dirname(projectPath))
		: filename.replace(PROJECT_SUFFIX, "");
}
