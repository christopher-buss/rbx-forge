import assert from "node:assert/strict";
import type { Buffer } from "node:buffer";
import type { ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { onTestFinished } from "vitest";

import type { CommandContext } from "../../src/commands/context.ts";
import type { PinnedProcess } from "../../src/native/addon.ts";
import { readVariable } from "../../src/process/environment.ts";
import { rojoWrapperPath, writeRojoWrapper } from "../../src/rojo/wrapper-project.ts";
import { findStudioExecutable } from "../../src/studio/discover.ts";
import { writeSessionMarkerAsync } from "../../src/studio/session-marker.ts";
import { waitForExitAsync } from "./real-native.ts";
import type { Observation } from "./real-studio-sync-fixture.ts";
import {
	createSyncContext,
	directSyncLauncher,
	genuineRojo,
	installSyncModelAsync,
	prepareSyncModel,
	requireClosedStudios,
	spawnSyncRojo,
	SYNC_FIXTURES,
	syncCollectorAsync,
} from "./real-studio-sync-fixture.ts";
import { makeTemporaryDirectory } from "./temporary-directory.ts";

/** The real engine, its source probe and explicitly owned processes. */
export interface RealStudioSync {
	isBlocked: () => boolean;
	observeForAsync: (milliseconds: number) => Promise<Array<Observation>>;
	projectName: string;
	restartRojoAsync: (otherName?: string) => Promise<void>;
	sessionId: string;
	stopRojoAsync: () => Promise<void>;
	waitForValueAsync: (value: string) => Promise<Observation>;
	writeProbe: (value: string) => void;
}

interface Runtime {
	child: ChildProcess | undefined;
	collector: { server: Server; url: string };
	context: CommandContext;
	didInstall: boolean;
	directory: string;
	executable: string;
	managed: string;
	observations: Array<Observation>;
	original: Buffer | undefined;
	port: number;
	projectName: string;
	rojo: string;
	sessionId: string;
	studio: PinnedProcess | undefined;
}

/**
 * Launch an authentic marker and current plugin with a bounded engine
 * observer.
 *
 * @param withMarker - Whether this Studio belongs to the Rojo session.
 * @returns Its observed tree and controls for restarting genuine Rojo.
 * @rejects Missing prerequisites, launch failure or absent engine observations.
 */
export async function makeRealStudioSyncAsync(withMarker: boolean): Promise<RealStudioSync> {
	requireClosedStudios();
	const runtime = await runtimeAsync();
	onTestFinished(async () => cleanupAsync(runtime));
	writeProbe(runtime, "initial");
	await restartRojoAsync(runtime);
	await launchAsync(runtime, withMarker);
	await waitAsync(() => runtime.observations.length > 0, "in-Studio observer");
	return controls(runtime);
}

async function runtimeAsync(): Promise<Runtime> {
	const rojo = genuineRojo();
	const directory = makeTemporaryDirectory();
	const context = createSyncContext(directory);
	const { seams } = context;
	const executable = findStudioExecutable(seams, { env: context.env });
	assert(executable !== undefined, "Install and log in to Studio before running sync tests");
	const home = readVariable(context.env, "USERPROFILE", "win32");
	assert(home !== undefined);
	const managed = path.join(home, "AppData/Local/Roblox/Plugins/RojoManagedPlugin.rbxm");
	const original = existsSync(managed) ? readFileSync(managed) : undefined;
	const observations: Array<Observation> = [];
	const port = await seams.network.freePortAsync();
	return {
		child: undefined,
		collector: await syncCollectorAsync(observations),
		context,
		didInstall: false,
		directory,
		executable: executable.path,
		managed,
		observations,
		original,
		port,
		projectName: "",
		rojo,
		sessionId: "",
		studio: undefined,
	};
}

async function waitAsync(
	predicate: () => boolean,
	description: string,
	timeoutMs = 90_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		assert(Date.now() < deadline, `Timed out waiting for ${description}`);
		await sleep(100);
	}
}

async function stopChildAsync(child: ChildProcess | undefined): Promise<void> {
	if (child === undefined) {
		return;
	}

	child.kill("SIGKILL");
	await Promise.race([
		waitForExitAsync(child),
		sleep(10_000).then(() => {
			throw new Error("Rojo did not exit");
		}),
	]);
}

async function cleanupAsync(runtime: Runtime): Promise<void> {
	try {
		runtime.studio?.kill();
		await waitAsync(() => runtime.studio?.isAlive() !== true, "owned Studio exit", 10_000);
	} finally {
		try {
			await stopChildAsync(runtime.child);
		} finally {
			runtime.collector.server.closeAllConnections();
			runtime.collector.server.close();
			if (runtime.didInstall) {
				if (runtime.original === undefined) {
					rmSync(runtime.managed, { force: true });
				} else {
					writeFileSync(runtime.managed, runtime.original);
				}
			}
		}
	}
}

function writeProbe({ context, directory }: Runtime, value: string): void {
	const project = path.join(directory, "default.project.json");
	const config = { buildOutputPath: "probe.rbxl", rojoProjectPath: project };
	writeFileSync(
		project,
		JSON.stringify({
			name: "forge-sync",
			tree: {
				$className: "DataModel",
				Workspace: {
					$className: "Workspace",
					ForgeSyncProbe: {
						$className: "StringValue",
						$properties: { Value: value },
					},
				},
			},
		}),
	);
	writeRojoWrapper(context, config, directory);
}

function setWrapperName(directory: string, otherName: string | undefined): void {
	if (otherName === undefined) {
		return;
	}

	const wrapper = JSON.parse(readFileSync(rojoWrapperPath(directory), "utf8"));
	assert(wrapper !== null && typeof wrapper === "object" && !Array.isArray(wrapper));
	wrapper["name"] = otherName;
	writeFileSync(rojoWrapperPath(directory), JSON.stringify(wrapper));
}

async function restartRojoAsync(runtime: Runtime, otherName?: string): Promise<void> {
	const {
		context: { seams },
		directory,
		port,
	} = runtime;
	assert(runtime.child === undefined, "Stop Rojo before restarting it");
	setWrapperName(directory, otherName);

	const child = spawnSyncRojo(runtime);
	runtime.child = child;
	let spawnError: Error | undefined;
	child.once("error", (error) => {
		spawnError = error;
	});
	const deadline = Date.now() + 15_000;
	while (!(await seams.network.isListeningAsync(port))) {
		assert(
			spawnError === undefined && Date.now() < deadline && child.exitCode === null,
			`Genuine Rojo did not listen: ${spawnError?.message ?? "timeout"}`,
		);
		await sleep(100);
	}

	const { projectName, sessionId } = await seams.network.getRojoInfoAsync(port);
	runtime.sessionId = sessionId;
	runtime.projectName ||= projectName;
}

async function observerScriptAsync(
	{ collector, context, directory, port }: Runtime,
	withMarker: boolean,
): Promise<string> {
	let marker = "";
	if (withMarker) {
		const generated = await writeSessionMarkerAsync(
			context,
			directory,
			port,
			AbortSignal.timeout(15_000),
		);
		marker = readFileSync(generated.runScript, "utf8");
	}

	const script = path.join(directory, "observe.lua");
	const observer = readFileSync(path.join(SYNC_FIXTURES, "studio/sync-observer.lua"), "utf8");
	writeFileSync(
		script,
		`${observer.replace("__FORGE_OBSERVER_URL__", () => {
			return JSON.stringify(collector.url);
		})}\n${marker}`,
	);
	return script;
}

async function launchAsync(runtime: Runtime, withMarker: boolean): Promise<void> {
	const {
		context,
		context: { seams },
		directory,
		executable,
	} = runtime;
	const model = prepareSyncModel(seams.native(), directory, runtime);
	const place = path.join(directory, "forge-sync.rbxl");
	copyFileSync(path.join(SYNC_FIXTURES, "studio/saved.rbxl"), place);
	const script = await observerScriptAsync(runtime, withMarker);
	const launched = await directSyncLauncher(context)({
		beforeLaunch: async () => {
			await installSyncModelAsync(runtime, model);
		},
		cwd: directory,
		env: context.env,
		place,
		runScript: script,
		studioPath: executable,
	});
	assert(
		launched.type === "launched" && launched.studio !== undefined,
		"Sync test requires a direct Studio launch",
	);
	const studio = seams.native().pinProcess(launched.studio.pid) ?? undefined;
	runtime.studio = studio;
	assert(studio !== undefined && studio.startTime === launched.studio.startTime);
}

async function waitForValueAsync({ observations }: Runtime, value: string): Promise<Observation> {
	await waitAsync(
		() => observations.some((entry) => entry.value === value && entry.connection !== ""),
		`Studio probe ${value}`,
	);
	const found = observations.find((entry) => entry.value === value && entry.connection !== "");
	assert(found !== undefined);
	return found;
}

async function stopRojoAsync(runtime: Runtime): Promise<void> {
	const start = runtime.observations.length;
	await stopChildAsync(runtime.child);
	runtime.child = undefined;
	await waitAsync(
		() => runtime.observations.slice(start).some(({ connection }) => connection === ""),
		"Studio disconnection",
		15_000,
	);
}

function controls(runtime: Runtime): RealStudioSync {
	const { observations, projectName } = runtime;
	return {
		isBlocked: () => runtime.studio?.isBlocked() ?? true,
		observeForAsync: async (milliseconds) => {
			const start = observations.length;
			await sleep(milliseconds);
			assert(runtime.studio?.isAlive() === true);
			return observations.slice(start);
		},
		projectName,
		restartRojoAsync: async (otherName) => restartRojoAsync(runtime, otherName),
		get sessionId() {
			return runtime.sessionId;
		},
		stopRojoAsync: async () => stopRojoAsync(runtime),
		waitForValueAsync: async (value) => waitForValueAsync(runtime, value),
		writeProbe: (value) => {
			writeProbe(runtime, value);
		},
	};
}
