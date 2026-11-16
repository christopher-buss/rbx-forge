/**
 * Relay the genuine helper, losing one completed mutation reply without
 * fabricating replies.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import process from "node:process";
import { createInterface } from "node:readline";

const TARGET = process.env["RBX_FORGE_TEST_HELPER_PROXY_TARGET"];
const LOG = process.env["RBX_FORGE_TEST_HELPER_PROXY_LOG"];
const DROP = process.env["RBX_FORGE_TEST_HELPER_PROXY_OPERATION"] ?? "requestSave";
assert(TARGET !== undefined && LOG !== undefined);
const child = spawn(TARGET, [], { stdio: "pipe", windowsHide: true });
const pending = new Map<string, string>();
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
	appendFileSync(LOG, `${JSON.stringify({ op: request.op })}\n`);
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
	if (operation === DROP && !existsSync(`${LOG}.lost`)) {
		writeFileSync(`${LOG}.lost`, line, { flag: "wx" });
		child.stdin.end();
		process.stdout.end();
	} else {
		process.stdout.write(`${line}\n`);
	}
});
process.stdin.on("end", () => {
	child.stdin.end();
});
child.stderr.pipe(process.stderr);
child.on("error", (error) => {
	throw error;
});
child.on("exit", (code) => {
	process.exit(code ?? 1);
});
