import { scope, type } from "arktype";

import { ForgeError } from "../errors.ts";

/** One instance in a Rojo sourcemap. Keys forge does not read are kept. */
export interface SourcemapNode {
	name: string;
	children?: Array<SourcemapNode>;
	// eslint-disable-next-line unicorn/no-keyword-prefix -- Rojo's key.
	className: string;
}

const sourcemapTypes = scope({
	node: { "name": "string", "children?": "node[]", "className": "string" },
}).export();

const sourcemapText = type("string.json.parse").pipe(sourcemapTypes.node);

/**
 * Parse the sourcemap `rojo sourcemap` wrote. Its root must be a place.
 *
 * @param text - The file's content.
 * @param file - The file's path, for the error message.
 * @returns The root instance.
 * @throws {ForgeError} `sourcemap_invalid` for text that is not a sourcemap,
 *   or for the sourcemap of a model.
 */
export function parseSourcemap(text: string, file: string): SourcemapNode {
	const root = sourcemapText(text);
	if (root instanceof type.errors) {
		throw new ForgeError(
			"sourcemap_invalid",
			`Rojo wrote a sourcemap forge cannot read (${file}):\n${root.summary}`,
			{ hint: "Check that rojoAlias runs Rojo, not another tool." },
		);
	}

	if (root.className !== "DataModel") {
		throw new ForgeError(
			"sourcemap_invalid",
			`The Rojo project's root is a ${root.className}, not a DataModel: forge typegen types the services of a place.`,
		);
	}

	return root;
}
