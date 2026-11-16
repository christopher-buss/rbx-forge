/**
 * Relay the genuine helper, losing one completed mutation reply without
 * fabricating replies.
 */
// cspell:words drvfs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import process from "node:process";
import { createInterface } from "node:readline";

const TARGET = process.env["RBX_FORGE_TEST_HELPER_PROXY_TARGET"];
const LOG = process.env["RBX_FORGE_TEST_HELPER_PROXY_LOG"];
const DROP = process.env["RBX_FORGE_TEST_HELPER_PROXY_OPERATION"] ?? "requestSave";
const EVIDENCE = process.env["RBX_FORGE_TEST_REAL_STUDIO_LOG"];
const PLACE = process.env["RBX_FORGE_TEST_HELPER_PROXY_PLACE"];
assert(TARGET !== undefined && LOG !== undefined);
const child = spawn(TARGET, [], { stdio: "pipe", windowsHide: true });
const pending = new Map<string, string>();

function note(entry: Record<string, unknown>): void {
	if (EVIDENCE === undefined) {
		return;
	}

	let file: unknown;
	try {
		const stat = PLACE === undefined ? undefined : statSync(PLACE);
		file = stat === undefined ? undefined : { bytes: stat.size, mtimeMs: stat.mtimeMs };
	} catch (err) {
		file = { error: String(err) };
	}

	appendFileSync(
		`${EVIDENCE}.helper-${process.pid}`,
		`${JSON.stringify({ at: Date.now(), file, pid: process.pid, ...entry })}\n`,
	);
}

createInterface({ input: process.stdin }).on("line", (line) => {
	const request: unknown = JSON.parse(line);
	assert(
		typeof request === "object" &&
			request !== null &&
			"id" in request &&
			"op" in request &&
			typeof request.id === "string" &&
			typeof request.op === "string",
	);
	pending.set(request.id, request.op);
	// Each request-count file has one writer, including on drvfs.
	appendFileSync(`${LOG}.requests-${process.pid}`, `${JSON.stringify({ op: request.op })}\n`);
	note({ command: "helper-loss-request", operation: request.op, request });

	child.stdin.write(`${line}\n`);
});
createInterface({ input: child.stdout }).on("line", (line) => {
	const reply: unknown = JSON.parse(line);
	assert(
		typeof reply === "object" &&
			reply !== null &&
			"id" in reply &&
			typeof reply.id === "string",
	);
	const operation = pending.get(reply.id);
	pending.delete(reply.id);
	if (operation !== undefined) {
		note({ command: "helper-loss-reply", operation, reply });
	}

	if (operation === DROP && !existsSync(`${LOG}.lost`)) {
		writeFileSync(`${LOG}.lost`, line, { flag: "wx" });
		child.stdin.end();
		process.stdout.end();
	} else {
		process.stdout.write(`${line}\n`);
	}
});
process.on("SIGTERM", () => {
	note({ command: "helper-loss-terminated", pending: [...pending.values()] });
	child.kill();
});
process.stdin.on("end", () => {
	note({ command: "helper-loss-client-end", pending: [...pending.values()] });
	child.stdin.end();
});
child.stderr.pipe(process.stderr);
child.on("error", (error) => {
	throw error;
});
child.on("exit", (code) => {
	process.exit(code ?? 1);
});
