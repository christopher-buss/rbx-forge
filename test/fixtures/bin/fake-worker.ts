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
 * - `FIXTURE_ROJO_NO_SYNCBACK=1`: rojo has no `syncback` command.
 * - `FIXTURE_ROJO_ERROR`: `rojo syncback` prints this and exits with code 1.
 * - `FIXTURE_SOURCEMAP`: what `rojo sourcemap --output <file>` writes; no
 *   file when unset.
 * - `FIXTURE_COMPILER_OUTPUT`: a file whose bytes a one-shot `rbxtsc` writes
 *   to stdout before it exits, such as recorded compiler output.
 * - `FIXTURE_PLACE_CONTENT`: what `rojo build` writes to its output (default
 *   `fake place`).
 *
 * The `open` and `xdg-open` roles stand in for the platform launcher: they
 * start a detached `studio` with their arguments and exit at once, as the
 * real launchers hand a file to its app. A `studio` stays alive until killed.
 *
 * Markers (`RBX_FORGE_SESSION`, `RBX_FORGE_WORKER`) are recorded as seen and
 * inherited by every grandchild unchanged.
 */
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
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

function runSyncback(): void {
	if (env["FIXTURE_ROJO_NO_SYNCBACK"] === "1") {
		process.stderr.write("error: unrecognized subcommand 'syncback'\n");
		process.exitCode = 2;
		return;
	}

	if (ARGS.includes("--help")) {
		process.stdout.write("Usage: rojo syncback [PROJECT] --input <INPUT>\n");
		return;
	}

	const error = env["FIXTURE_ROJO_ERROR"];
	if (error !== undefined) {
		process.stderr.write(`${error}\n`);
		process.exitCode = 1;
		return;
	}

	exitOnce();
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

	if (command === "syncback") {
		runSyncback();
		return;
	}

	const outputIndex = ARGS.findIndex((argument) => argument === "--output" || argument === "-o");
	const output = outputIndex === -1 ? undefined : ARGS[outputIndex + 1];
	if (command === "build" && output !== undefined) {
		writeFileSync(output, env["FIXTURE_PLACE_CONTENT"] ?? "fake place\n");
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

	const output = env["FIXTURE_COMPILER_OUTPUT"];
	if (output !== undefined) {
		process.stdout.write(readFileSync(output));
	}

	exitOnce();
}

function runLauncher(): void {
	exitOnce();
	if (process.exitCode !== 0) {
		return;
	}

	const studio = spawn(process.execPath, [import.meta.filename, "studio", ...ARGS], {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	studio.unref();
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
	case "grandchild":
	case "studio": {
		setInterval(doNothing, KEEP_ALIVE_MS);
		break;
	}
	case "hook": {
		runHook();
		break;
	}
	case "open":
	case "xdg-open": {
		runLauncher();
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
