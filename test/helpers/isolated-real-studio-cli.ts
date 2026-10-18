import assert from "node:assert/strict";
import type { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import type { NativeAddon } from "../../src/native/addon.ts";

const REPOSITORY = path.join(import.meta.dirname, "../..");
const GATE_ATTRIBUTE = "__ForgeRealStudioGate";

/** A built CLI whose plugins and launch markers belong to one fixture. */
export interface IsolatedRealStudioCli {
	bin: string;
	bundledPlugin: string;
	captureName: string;
	close: () => void;
	installedPlugin: string;
	launchAttributes: Record<string, string>;
	managedPlugin: string;
}

interface CanonicalModel {
	bytes: Buffer | undefined;
	file: string;
	modified: number | undefined;
}

interface Isolation {
	bootstrap: string;
	bundle: string;
	captureName: string;
	forgeName: string;
	gate: string;
	installedPlugin: string;
	managedPlugin: string;
	rojoName: string;
	token: string;
}

/**
 * Give production installation its own plugin filenames and marker namespace.
 *
 * @param options - The fixture directory, genuine addon, and real Plugins folder.
 * @returns A private built CLI and cleanup after all owned Studios have stopped.
 * @throws When the build's launch anchors change or a canonical plugin changes.
 */
export function isolatedRealStudioCli({
	directory,
	native,
	pluginsDirectory,
}: {
	directory: string;
	native: NativeAddon;
	pluginsDirectory: string;
}): IsolatedRealStudioCli {
	const isolation = isolationPaths(directory, pluginsDirectory);
	const canonical = canonicalModels(pluginsDirectory);
	function close(): void {
		rmSync(isolation.installedPlugin, { force: true });
		rmSync(isolation.managedPlugin, { force: true });
		for (const model of canonical) {
			assertCanonicalModel(model);
		}
	}

	try {
		return { ...prepareIsolation(isolation, native), close };
	} catch (err) {
		close();
		throw err;
	}
}

function isolationPaths(directory: string, pluginsDirectory: string): Isolation {
	const token = randomBytes(16).toString("hex");
	const forgeName = `ForgePluginTest-${token}.rbxm`;
	const rojoName = `ForgeRojoTest-${token}.rbxm`;
	return {
		bootstrap: `local deadline=os.clock()+600
while game:GetAttribute(${JSON.stringify(GATE_ATTRIBUTE)})~=${JSON.stringify(token)} do
 if os.clock()>=deadline then return end
 task.wait(0.1)
end
`,
		bundle: path.join(directory, `isolated-cli-${token}`),
		captureName: `ForgeCapture_${token}`,
		forgeName,
		gate: `game:SetAttribute(${JSON.stringify(GATE_ATTRIBUTE)},${JSON.stringify(token)});`,
		installedPlugin: path.join(pluginsDirectory, forgeName),
		managedPlugin: path.join(pluginsDirectory, rojoName),
		rojoName,
		token,
	};
}

function canonicalModels(pluginsDirectory: string): Array<CanonicalModel> {
	return ["ForgePlugin.rbxm", "RojoManagedPlugin.rbxm"].map((name) => {
		const file = path.join(pluginsDirectory, name);
		return {
			bytes: existsSync(file) ? readFileSync(file) : undefined,
			file,
			modified: existsSync(file) ? statSync(file).mtimeMs : undefined,
		};
	});
}

function linkDependencies(source: string, destination: string): void {
	mkdirSync(destination);
	for (const name of readdirSync(source)) {
		if (name.startsWith(".")) {
			continue;
		}

		const original = path.join(source, name);
		const target = path.join(destination, name);
		if (name.startsWith("@")) {
			linkDependencies(original, target);
		} else if (statSync(original).isDirectory()) {
			symlinkSync(realpathSync.native(original), target, "junction");
		}
	}
}

function copyBundle(bundle: string): void {
	mkdirSync(bundle);
	cpSync(path.join(REPOSITORY, "dist"), path.join(bundle, "dist"), { recursive: true });
	cpSync(path.join(REPOSITORY, "bin"), path.join(bundle, "bin"), { recursive: true });
	copyFileSync(path.join(REPOSITORY, "package.json"), path.join(bundle, "package.json"));
	linkDependencies(path.join(REPOSITORY, "node_modules"), path.join(bundle, "node_modules"));
}

function replaceOne(source: string, before: string, after: string): string {
	assert.equal(source.split(before).length, 2, `Expected one built CLI anchor: ${before}`);
	return source.replace(before, () => after);
}

function injectSnapshotGate(source: string, gate: string): string {
	const marker = 'return `local m=Instance.new("Configuration");m.Name="ForgeCapture"';
	return source.includes(marker)
		? replaceOne(
				source,
				marker,
				`return \`${gate}local m=Instance.new("Configuration");m.Name="ForgeCapture"`,
			)
		: source;
}

function injectGates(
	input: string,
	{ gate, gateFile }: { gate: string; gateFile: string },
	counts: { launcher: number; marker: number },
): string {
	const marker = 'return `local m=Instance.new("Configuration");m.Name="ROJO_OPEN_"';
	const launcher = "function studioArguments({ place, runScript }) {";
	let source = input;
	if (source.includes(marker)) {
		source = replaceOne(
			source,
			marker,
			`return \`${gate}local m=Instance.new("Configuration");m.Name="ROJO_OPEN_"`,
		);
		counts.marker += 1;
	}

	if (source.includes(launcher)) {
		source = replaceOne(
			source,
			launcher,
			`function studioArguments({ place, runScript = ${JSON.stringify(gateFile)} }) {`,
		);
		counts.launcher += 1;
	}

	return injectSnapshotGate(source, gate);
}

function privateNames(
	source: string,
	{ captureName, forgeName, rojoName, token }: Isolation,
): string {
	return source
		.replaceAll("ForgePlugin.rbxm", () => forgeName)
		.replaceAll("RojoManagedPlugin.rbxm", () => rojoName)
		.replaceAll("ROJO_OPEN_", () => `FORGE_TEST_ROJO_${token}_`)
		.replaceAll("ForgeCapture", () => captureName);
}

function isolateJavaScript(bundle: string, options: Isolation & { gateFile: string }): void {
	const counts = { launcher: 0, marker: 0 };
	const files = readdirSync(path.join(bundle, "dist")).filter((name) => name.endsWith(".mjs"));
	for (const name of files) {
		const file = path.join(bundle, "dist", name);
		const source = injectGates(readFileSync(file, "utf8"), options, counts);
		writeFileSync(file, privateNames(source, options));
	}

	assert.equal(counts.marker, 1, "The session marker opens this fixture's plugin gates");
	assert.equal(counts.launcher, 1, "Snapshot launches open this fixture's plugin gates");
}

function isolateForgeModel(
	native: NativeAddon,
	model: string,
	bootstrap: string,
	captureName: string,
): void {
	const mainPath = ["ForgePlugin", "plugin", "main"];
	const capturePath = ["ForgePlugin", "plugin", "capture"];
	const paths = [mainPath, capturePath];
	const [main, capture] = native.readModelScriptSources(model, paths);
	assert(main !== undefined && capture !== undefined);
	native.writeModelScriptSources(model, [
		{ path: mainPath, source: bootstrap + main },
		{
			path: capturePath,
			source: capture.replaceAll('"ForgeCapture"', () => JSON.stringify(captureName)),
		},
	]);
}

function isolateRojoModel(
	native: NativeAddon,
	plugin: string,
	bootstrap: string,
	directory: string,
): void {
	const model = path.join(directory, path.basename(plugin));
	writeFileSync(
		model,
		gunzipSync(readFileSync(path.join(REPOSITORY, "test/fixtures/models/rojo-7.7.1.rbxm.gz"))),
	);
	const [main, settings] = native.readModelScriptSources(model, [
		["Rojo", "Plugin"],
		["Rojo", "Plugin", "Settings"],
	]);
	assert(main !== undefined && settings !== undefined);
	const proxy = readFileSync(
		path.join(REPOSITORY, "test/fixtures/studio/sync-settings.lua"),
		"utf8",
	)
		.replace("__FORGE_SYNC_PORT__", '"0"')
		.replace("__FORGE_SYNC_NAME__", '"owned-fixture"');
	native.writeModelScriptSources(model, [
		{ path: ["Rojo", "Plugin"], source: bootstrap + main },
		{ path: ["Rojo", "Plugin", "Settings"], source: `${proxy}\n${settings}` },
	]);
	mkdirSync(path.dirname(plugin), { recursive: true });
	// Published plugins already contain their owned launch gate.
	copyFileSync(model, plugin);
}

function prepareIsolation(
	isolation: Isolation,
	native: NativeAddon,
): Pick<
	IsolatedRealStudioCli,
	| "bin"
	| "bundledPlugin"
	| "captureName"
	| "installedPlugin"
	| "launchAttributes"
	| "managedPlugin"
> {
	const {
		bootstrap,
		bundle,
		captureName,
		forgeName,
		gate,
		installedPlugin,
		managedPlugin,
		token,
	} = isolation;
	copyBundle(bundle);
	const gateFile = path.join(bundle, "studio-gate.lua");
	writeFileSync(gateFile, `${gate}\n`);
	isolateJavaScript(bundle, { ...isolation, gateFile });
	const bundledPlugin = path.join(bundle, "dist/forge-plugin", forgeName);
	copyFileSync(path.join(bundle, "dist/forge-plugin/ForgePlugin.rbxm"), bundledPlugin);
	isolateForgeModel(native, bundledPlugin, bootstrap, captureName);
	isolateRojoModel(native, managedPlugin, bootstrap, bundle);
	return {
		bin: path.join(bundle, "bin/rbx-forge.js"),
		bundledPlugin,
		captureName,
		installedPlugin,
		launchAttributes: { [GATE_ATTRIBUTE]: token },
		managedPlugin,
	};
}

function assertCanonicalModel({ bytes, file, modified }: CanonicalModel): void {
	assert.equal(existsSync(file), bytes !== undefined, `Canonical plugin changed: ${file}`);
	if (bytes !== undefined) {
		assert(readFileSync(file).equals(bytes), `Canonical plugin changed: ${file}`);
		assert.equal(statSync(file).mtimeMs, modified, `Canonical plugin was rewritten: ${file}`);
	}
}
