import assert from "node:assert/strict";

import type { NativeAddon } from "../../src/native/addon.ts";

/**
 * Fake model sources through the addon's instance-path contract.
 * @param addon - The injected native boundary.
 * @param sources - App, ServeSession, and Config sources, updated by writes.
 * @param model - The model these sources belong to.
 * @param version - The `Rojo.Version` value; missing when undefined.
 */
export function configureModelSources(
	addon: NativeAddon,
	sources: Array<string>,
	model: string,
	version?: string,
): void {
	const names = ["Rojo/Plugin/App", "Rojo/Plugin/ServeSession", "Rojo/Plugin/Config"];
	function indexOf(parts: Array<string>): number {
		const index = names.indexOf(parts.join("/"));
		if (index === -1) {
			throw new Error(`missing script path ${parts.join("/")}`);
		}

		return index;
	}

	addon.readModelScriptSources = (requested, paths) => {
		assert.equal(requested, model);
		return paths.map((parts) => {
			const source = sources[indexOf(parts)];
			assert(source !== undefined);
			return source;
		});
	};

	addon.readModelStringValues = (requested, paths) => {
		assert.equal(requested, model);
		return paths.map((parts) => versionAt(parts, version));
	};

	addon.writeModelScriptSources = (requested, scripts) => {
		assert.equal(requested, model);
		for (const { path: parts, source } of scripts) {
			sources[indexOf(parts)] = source;
		}
	};
}

function versionAt(parts: Array<string>, version: string | undefined): string {
	if (version === undefined || parts.join("/") !== "Rojo/Version") {
		throw new Error(`missing value path ${parts.join("/")}`);
	}

	return version;
}
