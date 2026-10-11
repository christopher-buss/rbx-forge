import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { onTestFinished } from "vitest";

import type { CommandContext } from "../../src/commands/context.ts";
import type { PinnedProcess } from "../../src/native/addon.ts";
import { readVariable } from "../../src/process/environment.ts";
import { rojoWrapperPath, writeRojoWrapper } from "../../src/rojo/wrapper-project.ts";
import type { StudioReadyListener } from "../../src/seams/network.ts";
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
	rewriteSyncMarkerNamespace,
	spawnSyncRojo,
	SYNC_FIXTURES,
	syncCollectorAsync,
} from "./real-studio-sync-fixture.ts";
import { makeTemporaryDirectory } from "./temporary-directory.ts";

/** The real engine, its source probe and explicitly owned processes. */
export interface RealStudioSync {
	cleanupAsync: () => Promise<void>;
	isBlocked: () => boolean;
	observeForAsync: (milliseconds: number) => Promise<Array<Observation>>;
	projectName: string;
	restartRojoAsync: (otherName?: string) => Promise<void>;
	sampleCursor: () => number;
	samplesSince: (cursor: number) => Array<Observation>;
	sessionId: string;
	stopRojoAsync: () => Promise<void>;
	studio: PinnedProcess;
	waitForReadyAsync: () => Promise<boolean>;
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
	observations: Array<Observation>;
	plugin: string;
	port: number;
	projectName: string;
	readiness?: StudioReadyListener;
	rojo: string;
	sessionId: string;
	studio: PinnedProcess | undefined;
	token: string;
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
	const executable = findStudioExecutable(context.seams, { env: context.env });
	assert(executable !== undefined, "Install and log in to Studio before running sync tests");
	const home = readVariable(context.env, "USERPROFILE", "win32");
	assert(home !== undefined);
	const token = randomBytes(32).toString("hex");
	const plugin = path.join(home, "AppData/Local/Roblox/Plugins", `ForgeSyncTest-${token}.rbxm`);
	const observations: Array<Observation> = [];
	const port = await context.seams.network.freePortAsync();
	return {
		child: undefined,
		collector: await syncCollectorAsync(observations),
		context,
		didInstall: false,
		directory,
		executable: executable.path,
		observations,
		plugin,
		port,
		projectName: "",
		rojo,
		sessionId: "",
		studio: undefined,
		token,
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
	runtime.readiness?.close();
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
				rmSync(runtime.plugin, { force: true });
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

async function observerScriptAsync(runtime: Runtime, withMarker: boolean): Promise<string> {
	const { collector, context, directory, port } = runtime;
	let marker = "";
	if (withMarker) {
		const generated = await writeSessionMarkerAsync(context, directory, port, {
			readyUrl: async (info) => {
				runtime.readiness = await context.seams.network.listenForStudioReadyAsync(
					info,
					AbortSignal.timeout(90_000),
				);
				return runtime.readiness.url;
			},
			signal: AbortSignal.timeout(15_000),
		});
		// The installed managed plugin cannot consume this test plugin's marker.
		marker = rewriteSyncMarkerNamespace(
			readFileSync(generated.runScript, "utf8"),
			runtime.token,
		);
	}

	const script = path.join(directory, "observe.lua");
	const observer = readFileSync(path.join(SYNC_FIXTURES, "studio/sync-observer.lua"), "utf8");
	writeFileSync(
		script,
		`game:SetAttribute("__ForgeSyncTestLaunch", ${JSON.stringify(runtime.token)})\n${observer.replace(
			"__FORGE_OBSERVER_URL__",
			() => JSON.stringify(collector.url),
		)}\n${marker}`,
	);
	return script;
}

async function launchAsync(runtime: Runtime, withMarker: boolean): Promise<void> {
	const { context, directory, executable } = runtime;
	const { seams } = context;
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
	assert(studio !== undefined && studio.startTime === launched.studio.startTime);
	runtime.studio = studio;
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
	const { observations, projectName, studio } = runtime;
	assert(studio !== undefined);
	return {
		cleanupAsync: async () => cleanupAsync(runtime),
		isBlocked: () => studio.isBlocked(),
		observeForAsync: async (milliseconds) => {
			const start = observations.length;
			await sleep(milliseconds);
			assert(studio.isAlive());
			return observations.slice(start);
		},
		projectName,
		restartRojoAsync: async (otherName) => restartRojoAsync(runtime, otherName),
		sampleCursor: () => observations.length - 1,
		samplesSince: (cursor) => observations.slice(cursor),
		get sessionId() {
			return runtime.sessionId;
		},
		stopRojoAsync: async () => stopRojoAsync(runtime),
		studio,
		waitForReadyAsync: async () => runtime.readiness?.ready ?? false,
		waitForValueAsync: async (value) => waitForValueAsync(runtime, value),
		writeProbe: (value) => {
			writeProbe(runtime, value);
		},
	};
}
