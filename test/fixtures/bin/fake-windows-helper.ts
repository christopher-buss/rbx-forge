/** Linux protocol fixture with synthetic Windows PIDs and start times. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import process from "node:process";
import { createInterface } from "node:readline";

interface Request {
	id: string;
	args?: Array<string>;
	op: string;
	port?: number | undefined;
	route?: string | undefined;
	visibility?: string | undefined;
}
interface State {
	actualPid: number;
	hidden?: boolean | undefined;
	hiding?: boolean | undefined;
	pid: number;
	place: string;
	startTime: string;
	watcherPid?: number | undefined;
}
const STATE_FILE = process.env["FIXTURE_HELPER_STATE"] ?? "";
const MODE = process.argv[2];
if (MODE === "path") {
	const input = process.argv[4] ?? "";
	process.stdout.write(
		process.argv[3] === "-w"
			? `\\\\wsl.localhost\\fixture${input.replaceAll("/", "\\")}\r`
			: input.slice(23).replaceAll("\\", "/"),
	);
} else if (MODE === "studio") {
	const place = process.argv[3] ?? "";
	writeFileSync(`${place}.lock`, `${process.pid + 1_000_000}\nRobloxStudioBeta\nWINDOWS\n`);
	process.on("SIGTERM", () => {
		unlinkSync(`${place}.lock`);
		process.exit(0);
	});
	setInterval(() => {
		/* Keep the fixture Studio alive until a close request. */
	}, 1000);
} else {
	createInterface({ input: process.stdin }).on("line", (line) => {
		void replyAsync(line);
	});
}

async function probeAsync(request: Request): Promise<Array<number>> {
	if (process.env["FIXTURE_HELPER_UNREACHABLE"] === "1") {
		throw new Error("unreachable");
	}

	const response = await fetch(`http://127.0.0.1:${request.port}${request.route}`);
	assert(response.ok);
	return [...new Uint8Array(await response.arrayBuffer())];
}

function launch(windowsPlace: string): unknown {
	const place = windowsPlace.slice(23).replaceAll("\\", "/");
	const child = spawn(process.execPath, [import.meta.filename, "studio", place], {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	child.unref();
	assert(child.pid !== undefined);
	const pid = child.pid + 1_000_000;
	const startTime = String((BigInt(Date.now()) + 11_644_473_600_000n) * 10_000n);
	writeFileSync(STATE_FILE, JSON.stringify({ actualPid: child.pid, pid, place, startTime }));
	return { pid, pin: "1", startTime };
}

function readState(): State {
	const value: unknown = JSON.parse(readFileSync(STATE_FILE, "utf8"));
	assert(
		typeof value === "object" &&
			value !== null &&
			"actualPid" in value &&
			typeof value.actualPid === "number" &&
			"pid" in value &&
			typeof value.pid === "number" &&
			"place" in value &&
			typeof value.place === "string" &&
			"startTime" in value &&
			typeof value.startTime === "string",
	);
	return {
		actualPid: value.actualPid,
		hidden: "hidden" in value && value.hidden === true,
		hiding: "hiding" in value && value.hiding === true,
		pid: value.pid,
		place: value.place,
		startTime: value.startTime,
		watcherPid:
			"watcherPid" in value && typeof value.watcherPid === "number"
				? value.watcherPid
				: undefined,
	};
}

function terminate(pid: number, signal: NodeJS.Signals): boolean {
	process.kill(pid, signal);
	return true;
}

// eslint-disable-next-line flawless/max-lines-per-function -- Flat fixture protocol operations.
function control(op: string, visibility?: string): unknown {
	const state = readState();
	const operations = new Map<string, () => unknown>([
		["desktop", () => "user"],
		["executablePath", () => process.env["FIXTURE_HELPER_EXECUTABLE"]],
		["isAlive", () => existsSync(`${state.place}.lock`)],
		["isBlocked", () => false],
		["kill", () => terminate(state.actualPid, "SIGKILL")],
		[
			"pin",
			() => {
				return { pid: state.pid, pin: "1", startTime: state.startTime };
			},
		],
		["processStartTime", () => state.startTime],
		["requestClose", () => terminate(state.actualPid, "SIGTERM")],
		[
			"setWindowVisibility",
			() => {
				writeFileSync(
					STATE_FILE,
					JSON.stringify({ ...state, hidden: visibility === "hidden", hiding: false }),
				);
				return true;
			},
		],
		[
			"startWindowHiding",
			() => {
				writeFileSync(
					STATE_FILE,
					JSON.stringify({
						...state,
						hidden: true,
						hiding: true,
						watcherPid: process.ppid,
					}),
				);
				return true;
			},
		],
		[
			"stopWindowHiding",
			() => {
				writeFileSync(STATE_FILE, JSON.stringify({ ...state, hiding: false }));
				return true;
			},
		],
		["windowHiding", () => state.hiding === true && existsSync(`${state.place}.lock`)],
		["windowVisibility", () => (state.hidden === true ? "hidden" : "user")],
	]);
	const operation = operations.get(op);
	assert(operation !== undefined, `Unexpected helper operation ${op}`);
	return operation();
}

function execute(request: Request): unknown {
	if (request.op === "handshake") {
		return {
			helperArch: process.arch,
			hostname: "WINDOWS",
			protocol: 1,
			windowsArch: process.arch,
		};
	}

	if (request.op === "launch") {
		const { args } = request;
		assert(args !== undefined);
		const index = args.indexOf("--localPlaceFile");
		const place = args[index === -1 ? 0 : index + 1];
		assert(place !== undefined);
		return launch(place);
	}

	return control(request.op, request.visibility);
}

function parseRequest(line: string): Request {
	const value: unknown = JSON.parse(line);
	assert(
		typeof value === "object" &&
			value !== null &&
			"id" in value &&
			typeof value.id === "string" &&
			"op" in value &&
			typeof value.op === "string",
	);
	const args = "args" in value ? value.args : undefined;
	assert(
		args === undefined ||
			(Array.isArray(args) && args.every((item: unknown) => typeof item === "string")),
	);
	return {
		id: value.id,
		op: value.op,
		port: "port" in value && typeof value.port === "number" ? value.port : undefined,
		route: "route" in value && typeof value.route === "string" ? value.route : undefined,
		visibility:
			"visibility" in value && typeof value.visibility === "string"
				? value.visibility
				: undefined,
		...(args === undefined ? {} : { args }),
	};
}

async function replyAsync(line: string): Promise<void> {
	const request = parseRequest(line);
	try {
		const result = request.op === "probeHttp" ? await probeAsync(request) : execute(request);
		process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
	} catch {
		process.stdout.write(
			`${JSON.stringify({ id: request.id, error: { code: "operation_failed", message: "unreachable" } })}\n`,
		);
	}
}
