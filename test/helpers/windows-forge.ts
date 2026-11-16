import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import type { Fixture } from "../e2e/session-fixture.ts";
import type { UpRun } from "../e2e/up-fixture.ts";
import { parseResult } from "./output.ts";
import { realStudioHost } from "./real-studio-host.ts";

const WINDOWS_BUNDLE = `import fs from "node:fs";
import path from "node:path";
const bundle=path.join(project,"windows-cli");
if(!fs.existsSync(bundle)) {
 fs.mkdirSync(bundle);
 const origin=path.dirname(path.dirname(original));
 for(const folder of ["dist","bin"]) fs.cpSync(path.join(origin,folder),path.join(bundle,folder),{recursive:true});
 fs.copyFileSync(path.join(origin,"package.json"),path.join(bundle,"package.json"));
 linkDependencies(path.join(source,"node_modules"),path.join(bundle,"node_modules"));
}
function linkDependencies(origin,target) {
 fs.mkdirSync(target,{recursive:true});
 for(const name of fs.readdirSync(origin)) {
  if(name.startsWith(".")) continue;
  const entry=path.join(origin,name), link=path.join(target,name);
  if(name.startsWith("@")) linkDependencies(entry,link);
  else if(fs.statSync(entry).isDirectory()) fs.symlinkSync(fs.realpathSync.native(entry),link,"junction");
 }
}
const cli=path.join(bundle,"bin","rbx-forge.js");
`;

interface RunnerPaths {
	cli: string;
	cwd: string;
	native: string;
	project: string;
	source: string;
}

/**
 * Run the same private CLI as genuine Windows Node, with matching native
 * artifacts.
 * @param fixture - The owned project and private CLI.
 * @param argv - The CLI arguments.
 * @returns Its JSON result and process output.
 */
export async function windowsForgeAsync(
	fixture: Fixture,
	argv: ReadonlyArray<string>,
): Promise<UpRun> {
	const native = process.env["RBX_FORGE_TEST_WINDOWS_NATIVE_DIR"];
	const source = process.env["RBX_FORGE_TEST_WINDOWS_SOURCE"];
	assert(native !== undefined && source !== undefined);
	const host = realStudioHost();
	assert(fixture.bin !== undefined);
	const cli = await host.toHostPathAsync(fixture.bin);
	const cwd = await host.toHostPathAsync(fixture.project);
	const runner = writeRunner({ cli, cwd, native, project: fixture.project, source });
	const run = spawnSync(
		await windowsToolAsync("node.exe"),
		[await host.toHostPathAsync(runner), ...argv],
		{ cwd: fixture.project, encoding: "utf8", timeout: 120_000, windowsHide: true },
	);
	assert(run.stdout.trim() !== "", run.stderr);
	return {
		pid: run.pid,
		result: parseResult(run.stdout),
		status: run.status,
		stderr: run.stderr,
		stdout: run.stdout,
	};
}

/**
 * Switch the owned fixture to genuine Windows Rojo after its Linux session
 * stops. The Windows session chooses its port in its own network stack.
 * @param project - The owned fixture directory.
 */
export async function installWindowsRojoAsync(project: string): Promise<void> {
	const executable = path.join(project, "windows-rojo.exe");
	copyFileSync(await windowsToolAsync("rojo.exe"), executable);
	const config: unknown = JSON.parse(
		readFileSync(path.join(project, "rbx-forge.config.json"), "utf8"),
	);
	assert(typeof config === "object" && config !== null);
	const rojoAlias = await realStudioHost().toHostPathAsync(executable);
	writeFileSync(
		path.join(project, "rbx-forge.config.json"),
		JSON.stringify({ ...config, rojoAlias, rojoPort: undefined }),
	);
}

function writeRunner({ cli, cwd, native, project, source }: RunnerPaths): string {
	const runner = path.join(project, "windows-forge.mjs");
	writeFileSync(
		runner,
		`import assert from "node:assert/strict";
assert.equal(process.platform,"win32");
import {pathToFileURL} from "node:url";
process.env.RBX_FORGE_NATIVE_DIR=${JSON.stringify(native)};
process.env.RBX_FORGE_STUDIO_PATH="";
process.env.RBX_FORGE_TEST_NO_INSTALLED_STUDIO="";
const project=${JSON.stringify(cwd)};
const original=${JSON.stringify(cli)};
const source=${JSON.stringify(source)};
${WINDOWS_BUNDLE}
process.chdir(project);
process.argv[1]=cli;
await import(pathToFileURL(cli).href);
`,
	);
	return runner;
}

async function windowsToolAsync(name: "node.exe" | "rojo.exe"): Promise<string> {
	const run = spawnSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`(Get-Command ${name} -CommandType Application | Select-Object -First 1).Source`,
		],
		{ encoding: "utf8", timeout: 10_000, windowsHide: true },
	);
	assert(run.status === 0, run.stderr);
	return realStudioHost().fromHostPathAsync(run.stdout.trim());
}
