/**
 * One fake binary for every worker a session runs: rojo, the compiler, and
 * hooks. The first argument names the role; the shims written by
 * `test/helpers/fixture-bin.ts` pass it. Environment variables shape the
 * process tree, so a test builds any tree without extra files:
 *
 * - `FIXTURE_LOG`: NDJSON file; every process appends one `start` record.
 * - `FIXTURE_GRANDCHILDREN`: number of grandchildren a long-running role
 *   spawns. Grandchildren stay alive and spawn nothing.
 * - `FIXTURE_DETACH=1`: grandchildren start detached (own process group /
 *   session on POSIX), so they escape the parent's group.
 * - `FIXTURE_IGNORE_SIGNALS=1`: this process and its grandchildren ignore
 *   SIGINT, SIGTERM, SIGHUP, and SIGBREAK.
 * - `FIXTURE_EXIT_CODE`: exit code of a one-shot run (default 0).
 * - `FIXTURE_HANG=1`: a hook stays alive instead of exiting.
 * - `FIXTURE_SOURCEMAP`: what `rojo sourcemap --output <file>` writes; no
 *   file when unset.
 *
 * Markers (`RBX_FORGE_SESSION`, `RBX_FORGE_WORKER`) are recorded as seen and
 * inherited by every grandchild unchanged.
 */
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const ROJO_VERSION = "7.7.0";
const KEEP_ALIVE_MS = 60_000;
const IGNORED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const;

const [ROLE = "worker", ...ARGS] = process.argv.slice(2);
const { env } = process;

/** Signal handler and keep-alive tick: both only need to exist. */
function doNothing(): void {
	// Intentionally empty.
}

function record(): void {
	const logFile = env["FIXTURE_LOG"];
	if (logFile === undefined) {
		return;
	}

	const entry = {
		args: ARGS,
		event: "start",
		markers: { session: env["RBX_FORGE_SESSION"], worker: env["RBX_FORGE_WORKER"] },
		pid: process.pid,
		ppid: process.ppid,
		role: ROLE,
	};
	appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
}

function ignoreSignals(): void {
	if (env["FIXTURE_IGNORE_SIGNALS"] !== "1") {
		return;
	}

	for (const signal of IGNORED_SIGNALS) {
		process.on(signal, doNothing);
	}
}

function spawnGrandchildren(): void {
	const count = Number(env["FIXTURE_GRANDCHILDREN"] ?? "0");
	const isDetached = env["FIXTURE_DETACH"] === "1";
	const childEnvironment = { ...env, FIXTURE_GRANDCHILDREN: "0" };

	for (let index = 0; index < count; index++) {
		const child = spawn(process.execPath, [import.meta.filename, "grandchild"], {
			detached: isDetached,
			env: childEnvironment,
			stdio: "ignore",
			windowsHide: true,
		});
		child.unref();
	}
}

function stayAlive(): void {
	spawnGrandchildren();
	setInterval(doNothing, KEEP_ALIVE_MS);
}

function exitOnce(): void {
	process.exitCode = Number(env["FIXTURE_EXIT_CODE"] ?? "0");
}

function runRojo(): void {
	const [command] = ARGS;
	if (command === "--version") {
		process.stdout.write(`Rojo ${ROJO_VERSION}\n`);
		return;
	}

	if (command === "serve") {
		process.stdout.write("Rojo server listening\n");
		stayAlive();
		return;
	}

	const outputIndex = ARGS.findIndex((argument) => argument === "--output" || argument === "-o");
	const output = outputIndex === -1 ? undefined : ARGS[outputIndex + 1];
	if (command === "build" && output !== undefined) {
		writeFileSync(output, "fake place\n");
	}

	const sourcemap = env["FIXTURE_SOURCEMAP"];
	if (command === "sourcemap" && output !== undefined && sourcemap !== undefined) {
		writeFileSync(output, sourcemap);
	}

	exitOnce();
}

function runCompiler(): void {
	if (ARGS.includes("-w") || ARGS.includes("--watch")) {
		process.stdout.write("Found 0 errors. Watching for file changes.\n");
		stayAlive();
		return;
	}

	exitOnce();
}

function runHook(): void {
	if (env["FIXTURE_HANG"] === "1") {
		stayAlive();
		return;
	}

	exitOnce();
}

// Signals first, so a test that saw the record can rely on the handlers.
ignoreSignals();
record();

switch (ROLE) {
	case "grandchild": {
		setInterval(doNothing, KEEP_ALIVE_MS);
		break;
	}
	case "hook": {
		runHook();
		break;
	}
	case "rbxtsc": {
		runCompiler();
		break;
	}
	case "rojo": {
		runRojo();
		break;
	}
	default: {
		throw new Error(`fake-worker: unknown role "${ROLE}"`);
	}
}
