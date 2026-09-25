import path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem, PROJECT } from "../../test/helpers/seams.ts";
import type { IdentityRecord } from "./session-files.ts";
import {
	createSession,
	forgeFiles,
	listSessions,
	removeSession,
	sessionFiles,
} from "./session-files.ts";

const FORGE = forgeFiles(PROJECT);
const IDENTITY: IdentityRecord = {
	endpoint: "/run/rbx-forge-1000-abc/ctl.sock",
	pid: 4242,
	processStartTime: "99",
	sessionId: "s-1",
	startedAt: "2026-01-01T00:00:00.000Z",
	version: "2.0.0",
};

describe(forgeFiles, () => {
	it("should keep every file under the project's .forge directory", () => {
		expect.assertions(1);

		expect(forgeFiles(PROJECT)).toStrictEqual({
			current: path.join(PROJECT, ".forge", "current"),
			directory: path.join(PROJECT, ".forge"),
			lock: path.join(PROJECT, ".forge", "supervisor.lock"),
			sessions: path.join(PROJECT, ".forge", "sessions"),
		});
	});
});

describe(sessionFiles, () => {
	it("should keep a session's files in its own directory", () => {
		expect.assertions(1);

		const directory = path.join(PROJECT, ".forge", "sessions", "s-1");

		expect(sessionFiles(FORGE, "s-1")).toStrictEqual({
			directory,
			identity: path.join(directory, "supervisor.id"),
			lease: path.join(directory, "workers.lock"),
			output: path.join(directory, "output"),
			record: path.join(directory, "reaper.json"),
			sessionId: "s-1",
			state: path.join(directory, "state.json"),
			token: path.join(directory, "token"),
		});
	});
});

const SECRET = { value: "secret" };

describe(createSession, () => {
	it("should write the identity record, the token, and the current hint", () => {
		expect.assertions(2);

		const memory = createMemoryFileSystem({ ".forge/current": "old\n" });
		const files = createSession(memory.fileSystem, FORGE, IDENTITY, SECRET);

		expect(files).toStrictEqual(sessionFiles(FORGE, "s-1"));
		expect(memory.files()).toStrictEqual({
			".forge/current": "s-1\n",
			".forge/sessions/s-1/output": null,
			".forge/sessions/s-1/supervisor.id": `${JSON.stringify(IDENTITY)}\n`,
			".forge/sessions/s-1/token": "secret",
		});
	});

	it("should never replace an identity record", () => {
		expect.assertions(2);

		const memory = createMemoryFileSystem({ ".forge/sessions/s-1/supervisor.id": "first" });

		expect(() => createSession(memory.fileSystem, FORGE, IDENTITY, SECRET)).toThrow(/EEXIST/);
		expect(memory.files()[".forge/sessions/s-1/supervisor.id"]).toBe("first");
	});

	it("should never replace a token", () => {
		expect.assertions(1);

		const memory = createMemoryFileSystem({ ".forge/sessions/s-1/token": "first" });

		expect(() => createSession(memory.fileSystem, FORGE, IDENTITY, SECRET)).toThrow(/EEXIST/);
	});

	it("should make the token readable by its owner only", () => {
		expect.assertions(1);

		const memory = createMemoryFileSystem();
		const { token } = createSession(memory.fileSystem, FORGE, IDENTITY, SECRET);

		// memfs keeps the mode it was given on every OS.
		expect(memory.fileSystem.statSync(token).mode & 0o777).toBe(0o600);
	});

	it("should write the token through the writer it is given", () => {
		expect.assertions(2);

		const memory = createMemoryFileSystem();
		const written: Array<[string, string]> = [];
		const { token } = createSession(memory.fileSystem, FORGE, IDENTITY, {
			value: "secret",
			write: (file, text) => {
				written.push([file, text]);
			},
		});

		expect(written).toStrictEqual([[token, "secret"]]);
		expect(memory.files()[".forge/sessions/s-1/token"]).toBeUndefined();
	});
});

describe(listSessions, () => {
	it("should list every session directory", () => {
		expect.assertions(2);

		const memory = createMemoryFileSystem({
			".forge/sessions/a/supervisor.id": "",
			".forge/sessions/b/workers.lock": "",
		});

		expect(listSessions(memory.fileSystem, FORGE).toSorted()).toStrictEqual(["a", "b"]);
		expect(listSessions(createMemoryFileSystem().fileSystem, FORGE)).toStrictEqual([]);
	});
});

describe(removeSession, () => {
	it("should delete the session's directory and the hint that names it", () => {
		expect.assertions(1);

		const memory = createMemoryFileSystem({
			".forge/current": "s-1\n",
			".forge/sessions/s-1/supervisor.id": "",
			".forge/sessions/s-2/supervisor.id": "",
		});
		removeSession(memory.fileSystem, FORGE, "s-1");

		expect(memory.files()).toStrictEqual({ ".forge/sessions/s-2/supervisor.id": "" });
	});

	it("should keep a hint that names another session", () => {
		expect.assertions(1);

		const memory = createMemoryFileSystem({
			".forge/current": "s-2\n",
			".forge/sessions/s-1/supervisor.id": "",
		});
		removeSession(memory.fileSystem, FORGE, "s-1");

		expect(memory.files()).toStrictEqual({
			".forge/current": "s-2\n",
			".forge/sessions": null,
		});
	});

	it("should do nothing more when neither exists", () => {
		expect.assertions(1);

		const memory = createMemoryFileSystem();
		removeSession(memory.fileSystem, FORGE, "s-1");

		expect(memory.files()).toStrictEqual({});
	});
});
