import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { onTestFinished } from "vitest";

import type { PinnedStudio } from "../../src/seams/studio-host.ts";
import { realStudioHost } from "./real-studio-host.ts";

/**
 * Start an owned WSL stdio relay, leaving existing terminals alone.
 * @param options - The private CLI, disposable project and Linux environment.
 * @returns A verified Windows handle for closing this launch terminal.
 */
export async function ownedWslTerminalAsync({
	bin,
	project,
	variables,
}: {
	bin: string;
	project: string;
	variables: Record<string, string>;
}): Promise<PinnedStudio> {
	const script = writeLaunchScript(bin, project, variables);
	const pid = spawnOwnedRelay(script);
	const startTime = await realStudioHost().processStartTimeAsync(pid);
	assert(startTime !== null);
	const pin = await realStudioHost().pinProcessAsync(pid, startTime);
	assert(pin !== null);
	onTestFinished(async () => {
		await pin.killAsync();
		await pin.waitForExitAsync(10_000);
	});
	return pin;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function writeLaunchScript(
	bin: string,
	project: string,
	variables: Record<string, string>,
): string {
	const script = path.join(project, "owned-terminal.sh");
	const exports = Object.entries(variables).map(
		([name, value]) => `export ${name}=${shellQuote(value)}`,
	);
	writeFileSync(
		script,
		[
			"#!/bin/bash",
			"set -eu",
			...exports,
			`cd ${shellQuote(project)}`,
			"unset RBX_FORGE_NATIVE_DIR",
			`${shellQuote(process.execPath)} ${shellQuote(bin)} up --studio --json > owned-terminal-up.ndjson`,
			"exec sleep 600",
			"",
		].join("\n"),
	);
	writeFileSync(path.join(project, "owned-terminal-up.ndjson"), "");
	return script;
}

function powershellQuote(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function spawnOwnedRelay(script: string): number {
	const distro = process.env["WSL_DISTRO_NAME"];
	assert(distro !== undefined);
	const argumentsList = ["-d", distro, "--exec", "bash", `"${script}"`]
		.map(powershellQuote)
		.join(",");
	const command = `$p = Start-Process -FilePath wsl.exe -ArgumentList @(${argumentsList}) -WindowStyle Hidden -PassThru; $p.Id`;
	const run = spawnSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
			Buffer.from(command, "utf16le").toString("base64"),
		],
		{ encoding: "utf8", timeout: 10_000, windowsHide: true },
	);
	assert(run.status === 0, run.stderr);
	const pid = Number(run.stdout.trim());
	assert(Number.isSafeInteger(pid) && pid > 0);
	return pid;
}
