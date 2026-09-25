/**
 * One fake binary for every worker a session runs: rojo, the compiler, and
 * hooks. The first argument names the role; the shims written by
 * `test/helpers/fixture-bin.ts` pass it. Environment variables shape the
 * process tree, so a test builds any tree without extra files:
 *
 * - `FIXTURE_LOG`: NDJSON file; every process appends one `start` record,
 *   with the time it started (`at`, milliseconds since the Unix epoch).
 * - `FIXTURE_GRANDCHILDREN`: number of grandchildren a long-running role
 *   spawns. Grandchildren stay alive and spawn nothing.
 * - `FIXTURE_DETACH=1`: grandchildren start detached (own process group /
 *   session on POSIX), so they escape the parent's group.
 * - `FIXTURE_CHAIN`: every grandchild spawns one more grandchild (detached
 *   too with `FIXTURE_DETACH`) until this many links hang below it.
 * - `FIXTURE_ORPHAN=1`: a grandchild exits once it has spawned its next
 *   link, so the link is orphaned (double fork).
 * - `FIXTURE_STORM_MS`: the last link spawns one more plain grandchild this
 *   often, `FIXTURE_STORM_MAX` (default 20) in all: a bounded fork storm.
 * - `FIXTURE_SCRUB=1`: the worker's grandchildren start without the markers.
 * - `FIXTURE_GRANDCHILD_MODES`: a comma list, one mode per grandchild in
 *   order: `scrub` (starts without the markers), `close-lease` (closes the
 *   session's inherited lease descriptor before it writes its record,
 *   POSIX), or empty for neither.
 * - `FIXTURE_BEAT_LOG` and `FIXTURE_BEAT_MS`: every long-running process
 *   appends `{ at, pid, session }` to this NDJSON file this often, so a test
 *   sees when a process last ran.
 * - `FIXTURE_IGNORE_SIGNALS=1`: this process and its grandchildren ignore
 *   SIGINT, SIGTERM, SIGHUP, and SIGBREAK.
 * - `FIXTURE_EXIT_CODE`: exit code of a one-shot run (default 0).
 * - `FIXTURE_HANG=1`: a hook stays alive instead of exiting.
 * - `FIXTURE_HOOK_MS`: a hook runs this long, then exits with code 0.
 * - `FIXTURE_HANG_ROLE`: a one-shot run of this role (such as `rbxtsc` for a
 *   compile, `rojo` for a build) stays alive instead of exiting.
 * - `FIXTURE_EXIT_AFTER_MS`: a long-running role exits on its own after this
 *   long, with `FIXTURE_EXIT_CODE`. Its grandchildren stay alive.
 * - `FIXTURE_EXIT_ROLE`: only this role exits after `FIXTURE_EXIT_AFTER_MS`.
 * - `FIXTURE_ROJO_NO_SYNCBACK=1`: rojo has no `syncback` command.
 * - `rojo serve --port <port>` listens on that port of `127.0.0.1`, as Rojo
 *   does, after `FIXTURE_ROJO_LISTEN_DELAY_MS` (default 0), or never with
 *   `FIXTURE_ROJO_NO_LISTEN=1`.
 * - `FIXTURE_ROJO_ERROR`: `rojo syncback` prints this and exits with code 1.
 * - `FIXTURE_SOURCEMAP`: what `rojo sourcemap --output <file>` writes; no
 *   file when unset.
 * - `FIXTURE_COMPILER_OUTPUT`: a file whose bytes a one-shot `rbxtsc` writes
 *   to stdout before it exits, such as recorded compiler output.
 * - `FIXTURE_PLACE_CONTENT`: what `rojo build` writes to its output (default
 *   `fake place`).
 *
 * A `studio` stays alive until killed. Forge starts it directly when the
 * place holds the stand-in's bootstrap and `RBX_FORGE_STUDIO_PATH` names
 * Node, or a copy of Node named as Studio (so forge's identity check takes
 * it for Studio). The `open` and `xdg-open` roles stand in for the platform
 * launcher: they start a detached `studio` (`FIXTURE_STUDIO_EXE` when set)
 * with their arguments and exit at once. With `FIXTURE_STUDIO_LOCK=1` it
 * behaves as Studio with its place open (`studio-stand-in.ts`).
 *
 * Markers (`RBX_FORGE_SESSION`, `RBX_FORGE_WORKER`) are recorded as seen and
 * inherited by every grandchild unchanged.
 */
import { spawn } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	existsSync,
	fstatSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";

import { launchStudio, runStudio } from "./studio-stand-in.ts";

const ROJO_VERSION = "7.7.0";
const KEEP_ALIVE_MS = 60_000;
const IGNORED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const;
const DEFAULT_STORM_MAX = 20;
/** Descriptors past this are not searched for the lease. */
const MAX_FD = 256;

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
		at: Date.now(),
		event: "start",
		markers: { session: env["RBX_FORGE_SESSION"], worker: env["RBX_FORGE_WORKER"] },
		mode: env["FIXTURE_MODE"],
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

/**
 * The session's lease descriptor this process inherited (POSIX), found by
 * the lease file's device and inode. The lease is
 * `.forge/sessions/<session>/workers.lock` under the project (the cwd), or
 * `workers.lock` in the cwd for a bare reaper test.
 *
 * @returns The descriptor, or `undefined` when it holds none.
 */
function findLease(): number | undefined {
	const session = env["RBX_FORGE_SESSION"];
	if (session === undefined || process.platform === "win32") {
		return undefined;
	}

	const file = [path.join(".forge", "sessions", session, "workers.lock"), "workers.lock"].find(
		(candidate) => existsSync(candidate),
	);
	if (file === undefined) {
		return undefined;
	}

	const lease = statSync(file);
	for (let fd = 3; fd < MAX_FD; fd++) {
		try {
			const stat = fstatSync(fd);
			if (stat.dev === lease.dev && stat.ino === lease.ino) {
				return fd;
			}
		} catch {
			// Not open.
		}
	}

	return undefined;
}

function spawnGrandchild(childEnvironment: NodeJS.ProcessEnv): ReturnType<typeof spawn> {
	// Node closes every descriptor but the standard ones in a child, where a
	// native program keeps them: pass the lease on, as `exec` would.
	const lease = findLease();
	const child = spawn(process.execPath, [import.meta.filename, "grandchild"], {
		detached: env["FIXTURE_DETACH"] === "1",
		env: childEnvironment,
		stdio: lease === undefined ? "ignore" : ["ignore", "ignore", "ignore", lease],
		windowsHide: true,
	});
	child.unref();
	return child;
}

function withoutMarkers(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const scrubbed = { ...environment };
	delete scrubbed["RBX_FORGE_SESSION"];
	delete scrubbed["RBX_FORGE_WORKER"];
	return scrubbed;
}

function spawnGrandchildren(): void {
	const count = Number(env["FIXTURE_GRANDCHILDREN"] ?? "0");
	const modes = (env["FIXTURE_GRANDCHILD_MODES"] ?? "").split(",");
	const base: NodeJS.ProcessEnv = { ...env, FIXTURE_GRANDCHILDREN: "0" };
	delete base["FIXTURE_GRANDCHILD_MODES"];
	for (let index = 0; index < count; index++) {
		const mode = modes[index] ?? "";
		const isScrubbed = env["FIXTURE_SCRUB"] === "1" || mode === "scrub";
		const childEnvironment = isScrubbed ? withoutMarkers(base) : base;
		spawnGrandchild({ ...childEnvironment, FIXTURE_MODE: mode });
	}
}

/** Close the session's lease descriptor this process inherited. */
function closeLease(): void {
	const lease = findLease();
	if (lease !== undefined) {
		closeSync(lease);
	}
}

/**
 * Append one beat record.
 *
 * @param file - The `FIXTURE_BEAT_LOG` path.
 */
function writeBeat(file: string): void {
	const entry = { at: Date.now(), pid: process.pid, session: env["RBX_FORGE_SESSION"] };
	appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

/** Append a beat now and then while the process lives. */
function beat(): void {
	const beatLog = env["FIXTURE_BEAT_LOG"];
	if (beatLog === undefined) {
		return;
	}

	writeBeat(beatLog);
	setInterval(writeBeat, Number(env["FIXTURE_BEAT_MS"] ?? "50"), beatLog);
}

/**
 * Spawn plain grandchildren on a timer, up to the storm's size.
 *
 * @param intervalMs - Time between two spawns.
 */
function storm(intervalMs: number): void {
	const plain: NodeJS.ProcessEnv = { ...env, FIXTURE_CHAIN: "0", FIXTURE_ORPHAN: "0" };
	delete plain["FIXTURE_STORM_MS"];
	let left = Number(env["FIXTURE_STORM_MAX"] ?? String(DEFAULT_STORM_MAX));
	const timer = setInterval(() => {
		spawnGrandchild(plain);
		left--;
		if (left <= 0) {
			clearInterval(timer);
		}
	}, intervalMs);
}

/** A grandchild: the next link of a chain, a storm, or nothing. */
function runGrandchild(): void {
	setInterval(doNothing, KEEP_ALIVE_MS);
	beat();

	const links = Number(env["FIXTURE_CHAIN"] ?? "0");
	if (links > 0) {
		const link = spawnGrandchild({ ...env, FIXTURE_CHAIN: String(links - 1) });
		if (env["FIXTURE_ORPHAN"] === "1") {
			link.once("spawn", () => process.exit(0));
		}

		return;
	}

	const stormMs = env["FIXTURE_STORM_MS"];
	if (stormMs !== undefined) {
		storm(Number(stormMs));
	}
}

function stayAlive(): void {
	spawnGrandchildren();
	setInterval(doNothing, KEEP_ALIVE_MS);
	beat();
	const exitAfter = env["FIXTURE_EXIT_AFTER_MS"];
	const exitRole = env["FIXTURE_EXIT_ROLE"];
	if (exitAfter !== undefined && (exitRole === undefined || exitRole === ROLE)) {
		setTimeout(() => {
			process.exit(Number(env["FIXTURE_EXIT_CODE"] ?? "0"));
		}, Number(exitAfter));
	}
}

function exitOnce(): void {
	if (env["FIXTURE_HANG_ROLE"] === ROLE) {
		stayAlive();
		return;
	}

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

/** Listen on `--port`, as `rojo serve` does, for the session's port check. */
function listenOnPort(): void {
	const index = ARGS.indexOf("--port");
	const port = index === -1 ? undefined : ARGS[index + 1];
	if (port === undefined || env["FIXTURE_ROJO_NO_LISTEN"] === "1") {
		return;
	}

	setTimeout(
		() => {
			const server = createServer((socket) => {
				socket.destroy();
			});
			server.on("error", (err) => {
				process.stderr.write(`listen failed: ${err.message}\n`);
			});
			server.listen({ host: "127.0.0.1", port: Number(port) });
		},
		Number(env["FIXTURE_ROJO_LISTEN_DELAY_MS"] ?? "0"),
	);
}

function runRojo(): void {
	const [command] = ARGS;
	if (command === "--version") {
		process.stdout.write(`Rojo ${ROJO_VERSION}\n`);
		return;
	}

	if (command === "serve") {
		process.stdout.write("Rojo server listening\n");
		listenOnPort();
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
	if (process.exitCode === 0) {
		launchStudio(ARGS);
	}
}

function runHook(): void {
	if (env["FIXTURE_HANG"] === "1") {
		stayAlive();
		return;
	}

	const hookMs = env["FIXTURE_HOOK_MS"];
	if (hookMs !== undefined) {
		setTimeout(doNothing, Number(hookMs));
		return;
	}

	exitOnce();
}

// Signals and the lease first, so a test that saw the record can rely on
// the handlers, and on a closed lease.
ignoreSignals();
if (ROLE === "grandchild" && env["FIXTURE_MODE"] === "close-lease") {
	closeLease();
}

record();

switch (ROLE) {
	case "grandchild": {
		runGrandchild();
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
	case "studio": {
		runStudio(ARGS[0]);
		break;
	}
	default: {
		throw new Error(`fake-worker: unknown role "${ROLE}"`);
	}
}
