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
}
interface State {
	actualPid: number;
	pid: number;
	place: string;
	startTime: string;
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
		const request = parseRequest(line);
		process.stdout.write(`${JSON.stringify({ id: request.id, result: execute(request) })}\n`);
	});
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
		pid: value.pid,
		place: value.place,
		startTime: value.startTime,
	};
}

function terminate(pid: number, signal: NodeJS.Signals): boolean {
	process.kill(pid, signal);
	return true;
}

function control(op: string): unknown {
	const state = readState();
	const operations = new Map<string, () => unknown>([
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
		["windowVisibility", () => "user"],
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

	return control(request.op);
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
	return { id: value.id, op: value.op, ...(args === undefined ? {} : { args }) };
}
