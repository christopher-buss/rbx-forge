import path from "node:path";
import stripJsonComments from "strip-json-comments";

import type { FileSystem } from "../seams/file-system.ts";

/** Project-tree node names below one instance, keyed by child name. */
export interface DeclaredTree {
	[name: string]: DeclaredTree;
}

const PROJECT_FILE = /\.project\.jsonc?$/;
const DEFAULT_PROJECTS = ["default.project.json", "default.project.jsonc"];

/**
 * Read the nodes a Rojo project declares below its DataModel root. File content
 * under a `$path` is not declared; a nested project contributes its own tree.
 * @param fileSystem - Reads the project files.
 * @param projectPath - The absolute project file path.
 * @returns The declared names, rooted at the DataModel's children.
 */
export function readDeclaredTree(fileSystem: FileSystem, projectPath: string): DeclaredTree {
	return projectTree(fileSystem, projectPath, new Set());
}

/**
 * A null prototype lets any node name, even `__proto__`, be an own key.
 * @returns An empty tree without a prototype.
 */
function emptyTree(): DeclaredTree {
	return Object.create(null);
}

function projectTree(
	fileSystem: FileSystem,
	projectPath: string,
	visiting: Set<string>,
): DeclaredTree {
	if (visiting.has(projectPath)) {
		return emptyTree();
	}

	const content = stripJsonComments(fileSystem.readFileSync(projectPath, "utf8"), {
		trailingCommas: true,
	});
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Rojo validates the project shape
	const project = JSON.parse(content) as { tree: Record<string, unknown> };
	visiting.add(projectPath);
	const tree = nodeTree(fileSystem, project.tree, path.dirname(projectPath), visiting);
	visiting.delete(projectPath);
	return tree;
}

function isOptionalPath(target: unknown): target is { optional: unknown } {
	return typeof target === "object" && target !== null && "optional" in target;
}

function nestedProject(
	fileSystem: FileSystem,
	target: unknown,
	directory: string,
): string | undefined {
	const file = isOptionalPath(target) ? target.optional : target;
	if (typeof file !== "string") {
		return undefined;
	}

	const resolved = path.resolve(directory, file);
	if (PROJECT_FILE.test(resolved)) {
		return resolved;
	}

	return DEFAULT_PROJECTS.map((name) => path.join(resolved, name)).find((candidate) => {
		return fileSystem.existsSync(candidate);
	});
}

function mergeTrees(left: DeclaredTree, right: DeclaredTree): DeclaredTree {
	const merged = Object.assign(emptyTree(), left);
	for (const [name, child] of Object.entries(right)) {
		merged[name] = mergeTrees(merged[name] ?? emptyTree(), child);
	}

	return merged;
}

function nodeTree(
	fileSystem: FileSystem,
	node: Record<string, unknown>,
	directory: string,
	visiting: Set<string>,
): DeclaredTree {
	const nested = nestedProject(fileSystem, node["$path"], directory);
	const tree = nested === undefined ? emptyTree() : projectTree(fileSystem, nested, visiting);
	for (const [name, child] of Object.entries(node)) {
		if (name.startsWith("$")) {
			continue;
		}

		const declared = nodeTree(
			fileSystem,
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Rojo validates the project shape
			child as Record<string, unknown>,
			directory,
			visiting,
		);
		tree[name] = mergeTrees(tree[name] ?? emptyTree(), declared);
	}

	return tree;
}
