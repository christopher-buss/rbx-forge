import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { gunzipSync } from "node:zlib";

import type { CommandContext } from "../../src/commands/context.ts";
import type { NativeAddon } from "../../src/native/addon.ts";
import { readVariable } from "../../src/process/environment.ts";
import { createNodeSeams } from "../../src/seams/node-seams.ts";
import { createStudioLauncher } from "../../src/studio/launcher.ts";
import { SCRIPTS, VERSION } from "../../src/studio/rojo-plugin.ts";
import { NATIVE_DIRECTORY } from "./real-native.ts";
import { createRecordingReporter } from "./seams.ts";

/** One observation made inside the actual Studio process. */
export interface Observation {
	name: string;
	connection: string;
	sequence: number;
	value: string;
}

/** Paths to the complete stock model, saved place and test-only Lua. */
export const SYNC_FIXTURES = path.join(import.meta.dirname, "../fixtures");

/** Fail before changing a shared managed plugin used by another Studio. */
export function requireClosedStudios(): void {
	const listed = spawnSync("tasklist", ["/FO", "CSV", "/NH"], {
		encoding: "utf8",
		windowsHide: true,
	});
	assert.equal(listed.status, 0);
	assert(
		!listed.stdout.includes('"RobloxStudioBeta.exe"'),
		"Close existing Studios before running managed plugin sync tests",
	);
}

/**
 * Stage the prepared model only immediately before launching the owned Studio.
 *
 * @param target - The managed path and restoration flag.
 * @param model - The complete temporary plugin.
 */
export async function installSyncModelAsync(
	target: { didInstall: boolean; managed: string },
	model: string,
): Promise<void> {
	requireClosedStudios();
	await mkdir(path.dirname(target.managed), { recursive: true });
	target.didInstall = true;
	await copyFile(model, target.managed);
}

/**
 * Start only the explicitly resolved genuine server.
 *
 * @param options - The wrapper directory and fixed endpoint.
 * @returns The owned child process.
 */
export function spawnSyncRojo({
	directory,
	port,
	rojo,
}: {
	directory: string;
	port: number;
	rojo: string;
}): ChildProcess {
	return spawn(
		rojo,
		["serve", path.join(directory, "rojo.project.json"), "--port", String(port)],
		{ cwd: directory, stdio: "ignore", windowsHide: true },
	);
}

/**
 * Use the real direct launcher; prevent any unowned platform-fallback Studio.
 *
 * @param context - The real launcher backends.
 * @returns A launcher that fails if native breakaway is unavailable.
 */
export function directSyncLauncher({
	seams,
}: CommandContext): ReturnType<typeof createStudioLauncher> {
	return createStudioLauncher(
		{
			...seams,
			childProcess: {
				...seams.childProcess,
				spawn: () => {
					throw new Error(
						"Sync tests require direct launch; platform fallback has no owned Studio PID",
					);
				},
			},
		},
		path.join(import.meta.dirname, "..", "..", "src", "supervisor.ts"),
	);
}

/**
 * Resolve a genuine version-pinned server, outside the fake fixture PATH.
 *
 * @returns Its explicit executable path.
 */
export function genuineRojo(): string {
	const explicit = readVariable(process.env, "RBX_FORGE_TEST_REAL_ROJO", "win32");
	const search = readVariable(process.env, "PATH", "win32") ?? "";
	const executable =
		explicit ??
		search
			.split(path.delimiter)
			.map((entry) => path.join(entry, "rojo.exe"))
			.find((entry) => existsSync(entry));
	assert(
		executable !== undefined && path.isAbsolute(executable),
		"Install Rojo 7.7.1 or set RBX_FORGE_TEST_REAL_ROJO to its executable",
	);
	const version = spawnSync(executable, ["--version"], { encoding: "utf8", windowsHide: true });
	assert.equal(version.status, 0, `Could not execute genuine Rojo: ${version.stderr}`);
	assert.equal(
		version.stdout.trim(),
		"Rojo 7.7.1",
		"Real Studio sync tests require genuine Rojo 7.7.1",
	);
	return executable;
}

/**
 * Preserve complete stock reconciliation packages and exact current patches.
 *
 * @param native - The real model reader/writer.
 * @param directory - The temporary directory, never the managed plugin path.
 * @param identity - A saved prior endpoint for the test's own server.
 * @returns The model containing isolated persistence and shipped patch sources.
 */
export function prepareSyncModel(
	native: NativeAddon,
	directory: string,
	identity: { port: number; projectName: string },
): string {
	const model = path.join(directory, "RojoManagedPlugin.rbxm");
	writeFileSync(
		model,
		gunzipSync(readFileSync(path.join(SYNC_FIXTURES, "models/rojo-7.7.1.rbxm.gz"))),
	);
	const settingsPath = ["Rojo", "Plugin", "Settings"];
	const [settings] = native.readModelScriptSources(model, [settingsPath]);
	assert(settings !== undefined);
	const replacements = SCRIPTS.map(({ name, hash, source }) => {
		return {
			path: ["Rojo", "Plugin", name],
			source: `-- rbx-forge patch ${VERSION} stock ${hash}\n${source}`,
		};
	});
	const isolated = `${settingsProxy(identity)}\n${settings}`;
	native.writeModelScriptSources(model, [
		...replacements,
		{ path: settingsPath, source: isolated },
	]);
	assert.deepEqual(
		native.readModelScriptSources(
			model,
			replacements.map(({ path: scriptPath }) => scriptPath),
		),
		replacements.map(({ source }) => source),
	);
	return model;
}

/**
 * Collect repeated engine observations independently of readiness callbacks.
 *
 * @param observations - Where authenticated samples are appended.
 * @returns The owned server and unguessable loopback endpoint.
 */
export async function syncCollectorAsync(
	observations: Array<Observation>,
): Promise<{ server: Server; url: string }> {
	const token = randomBytes(32).toString("hex");
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "", "http://127.0.0.1");
		if (request.method !== "GET" || url.pathname !== `/${token}`) {
			response.writeHead(404).end();
			return;
		}

		observations.push({
			name: url.searchParams.get("name") ?? "",
			connection: url.searchParams.get("connection") ?? "",
			sequence: Number(url.searchParams.get("sequence")),
			value: url.searchParams.get("value") ?? "",
		});
		response.writeHead(200).end("observed");
	});
	server.requestTimeout = 2000;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert(address !== null && typeof address !== "string");
	return { server, url: `http://127.0.0.1:${address.port}/${token}` };
}

/**
 * Build real backends without starting a supervisor.
 *
 * @param directory - The temporary project root.
 * @returns A context for production marker and wrapper APIs.
 */
export function createSyncContext(directory: string): CommandContext {
	const seams = createNodeSeams({
		input: process.stdin,
		nativeDirectory: NATIVE_DIRECTORY,
		output: process.stdout,
		supervisorEntry: path.join(directory, "unused-supervisor.mjs"),
	});
	return {
		cwd: directory,
		env: { ...process.env },
		interactive: false,
		reporter: createRecordingReporter(),
		seams,
	};
}

function settingsProxy(identity: { port: number; projectName: string }): string {
	return readFileSync(path.join(SYNC_FIXTURES, "studio/sync-settings.lua"), "utf8")
		.replace("__FORGE_SYNC_PORT__", () => JSON.stringify(String(identity.port)))
		.replace("__FORGE_SYNC_NAME__", () => JSON.stringify(identity.projectName));
}
