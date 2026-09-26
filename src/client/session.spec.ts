import path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryTransport } from "../../test/helpers/fake-ipc.ts";
import { makeStatus, serveFakeSessionAsync } from "../../test/helpers/fake-session.ts";
import { createMemoryFileSystem, PROJECT } from "../../test/helpers/seams.ts";
import { forgeFiles } from "../supervisor/session-files.ts";
import { fetchStatusAsync, findSession, probeSessionAsync, readIdentity } from "./session.ts";

const FORGE = forgeFiles(PROJECT);
const IDENTITY = {
	endpoint: "e",
	pid: 1,
	processStartTime: "1",
	sessionId: "s1",
	startedAt: "t",
	version: "v",
};

describe(readIdentity, () => {
	it("should read a record, and nothing else", () => {
		expect.assertions(3);

		const memory = createMemoryFileSystem({
			"bad.id": '{"pid":1}',
			"good.id": JSON.stringify(IDENTITY),
		});

		expect(readIdentity(memory.fileSystem, path.join(PROJECT, "good.id"))).toStrictEqual(
			IDENTITY,
		);
		expect(readIdentity(memory.fileSystem, path.join(PROJECT, "bad.id"))).toBeUndefined();
		expect(readIdentity(memory.fileSystem, path.join(PROJECT, "none.id"))).toBeUndefined();
	});
});

describe(findSession, () => {
	it("should find the session current names, with its token", () => {
		expect.assertions(1);

		const memory = createMemoryFileSystem({
			".forge/current": "s1\n",
			".forge/sessions/s1/supervisor.id": JSON.stringify(IDENTITY),
			".forge/sessions/s1/token": "secret",
		});

		expect(findSession(memory.fileSystem, FORGE)).toMatchObject({
			files: { sessionId: "s1" },
			identity: IDENTITY,
			token: "secret",
		});
	});

	it.for([
		["no current hint", {}],
		["an empty current hint", { ".forge/current": "\n" }],
		["no identity record", { ".forge/current": "s1", ".forge/sessions/s1/token": "t" }],
		[
			"no token",
			{
				".forge/current": "s1",
				".forge/sessions/s1/supervisor.id": JSON.stringify(IDENTITY),
			},
		],
	] as const)("should find none with %s", ([, files]) => {
		expect.assertions(1);

		expect(findSession(createMemoryFileSystem(files).fileSystem, FORGE)).toBeUndefined();
	});
});

describe(fetchStatusAsync, () => {
	it("should reject an answer that is not a status as internal_error", async () => {
		expect.assertions(1);

		const memory = createMemoryFileSystem();
		const transport = createMemoryTransport();
		const fake = await serveFakeSessionAsync(memory, transport);
		fake.answer = { running: "yes" };
		const session = findSession(memory.fileSystem, FORGE);
		const fetched = fetchStatusAsync(transport, session!);

		await expect(fetched).rejects.toMatchObject({
			code: "internal_error",
			hint: "The session may run another forge version. Stop it, then start it again.",
			message: "The session answered status with something else.",
		});
	});
});

describe(probeSessionAsync, () => {
	it("should return the session and its status when it answers", async () => {
		expect.assertions(1);

		const memory = createMemoryFileSystem();
		const ipc = createMemoryTransport();
		const fake = await serveFakeSessionAsync(memory, ipc, makeStatus({ phase: "starting" }));

		await expect(
			probeSessionAsync({ fileSystem: memory.fileSystem, ipc }, FORGE),
		).resolves.toMatchObject({
			session: { identity: fake.identity },
			status: { phase: "starting" },
		});
	});

	it("should return nothing when no session is named or none answers", async () => {
		expect.assertions(2);

		const memory = createMemoryFileSystem();
		const ipc = createMemoryTransport();
		const none = await probeSessionAsync({ fileSystem: memory.fileSystem, ipc }, FORGE);

		expect(none).toBeUndefined();

		const fake = await serveFakeSessionAsync(memory, ipc);
		await fake.stop();

		await expect(
			probeSessionAsync({ fileSystem: memory.fileSystem, ipc }, FORGE),
		).resolves.toBeUndefined();
	});

	it("should pass on an answer that is not a status", async () => {
		expect.assertions(1);

		const memory = createMemoryFileSystem();
		const ipc = createMemoryTransport();
		const fake = await serveFakeSessionAsync(memory, ipc);
		fake.answer = {};

		await expect(
			probeSessionAsync({ fileSystem: memory.fileSystem, ipc }, FORGE),
		).rejects.toMatchObject({
			code: "internal_error",
		});
	});
});
