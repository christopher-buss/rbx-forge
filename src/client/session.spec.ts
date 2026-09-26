import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createMemoryTransport } from "../../test/helpers/fake-ipc.ts";
import { LET_GO, makeStatus, serveFakeSessionAsync } from "../../test/helpers/fake-session.ts";
import { createMemoryFileSystem, PROJECT } from "../../test/helpers/seams.ts";
import { forgeFiles } from "../supervisor/session-files.ts";
import {
	addPartsAsync,
	fetchStatusAsync,
	findSession,
	joinSessionAsync,
	probeSessionAsync,
	readIdentity,
} from "./session.ts";

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

describe(addPartsAsync, () => {
	it("should ask for the parts and return those the session started", async () => {
		expect.assertions(2);

		const memory = createMemoryFileSystem();
		const transport = createMemoryTransport();
		const fake = await serveFakeSessionAsync(memory, transport);
		const asked: Array<unknown> = [];
		fake.addParts = (parameters) => {
			asked.push(parameters);
			return { added: ["compiler", "studio", "rojo"] };
		};

		const session = findSession(memory.fileSystem, FORGE)!;

		await expect(
			addPartsAsync(transport, session, { parts: ["compiler", "studio"] }, 1000),
		).resolves.toStrictEqual(["compiler", "studio", "rojo"]);

		await addPartsAsync(transport, session, { parts: ["studio"], studioPath: "/opt/S" }, 1000);

		expect(asked).toStrictEqual([
			{ parts: ["compiler", "studio"] },
			{ parts: ["studio"], studioPath: "/opt/S" },
		]);
	});

	it("should reject an answer that is not a list of parts as internal_error", async () => {
		expect.assertions(1);

		const memory = createMemoryFileSystem();
		const transport = createMemoryTransport();
		const fake = await serveFakeSessionAsync(memory, transport);
		fake.addParts = () => ({ added: ["syncback"] });
		const added = addPartsAsync(
			transport,
			findSession(memory.fileSystem, FORGE)!,
			{ parts: [] },
			1000,
		);

		await expect(added).rejects.toMatchObject({
			code: "internal_error",
			hint: "The session may run another forge version. Stop it, then start it again.",
			message: "The session answered addParts with something else.",
		});
	});
});

describe(joinSessionAsync, () => {
	async function joinAsync(
		{
			join: joinAnswer = {},
			leave: leaveAnswer = {},
		}: { join?: Record<string, unknown>; leave?: Record<string, unknown> },
		signal = openSignal(),
	) {
		const memory = createMemoryFileSystem();
		const transport = createMemoryTransport();
		const fake = await serveFakeSessionAsync(memory, transport);
		const join = vi.spyOn(fake, "join");
		const leave = vi.spyOn(fake, "leave");
		join.mockReturnValue({ added: [], sessionId: "s1", taken: [], ...joinAnswer });
		leave.mockResolvedValue({ ...LET_GO, ...leaveAnswer });
		const asked = join.mock.calls;
		const joined = joinSessionAsync(
			transport,
			findSession(memory.fileSystem, FORGE)!,
			{ parts: ["compiler"] },
			{ signal, waitMs: 1000 },
		);
		return { asked, fake, joined };
	}

	function openSignal(): AbortSignal {
		const controller = new AbortController();
		return controller.signal;
	}

	function released(): AbortSignal {
		const release = new AbortController();
		release.abort();
		return release.signal;
	}

	it("should join with the parts it asks for, and read what letting go did", async () => {
		expect.assertions(3);

		const { asked, joined } = await joinAsync({
			join: { added: ["compiler"], sessionId: "s1", taken: ["rojo"] },
			leave: {
				ending: true,
				released: [],
				sessionId: "s1",
				stopped: ["compiler"],
				studioLeft: false,
			},
		});
		const session = await joined;

		expect(session!.joined).toStrictEqual({
			added: ["compiler"],
			sessionId: "s1",
			taken: ["rojo"],
		});
		await expect(session!.holdAsync(released(), 1000)).resolves.toStrictEqual({
			ending: true,
			released: [],
			sessionId: "s1",
			stopped: ["compiler"],
			studioLeft: false,
		});
		expect(asked).toStrictEqual([[{ parts: ["compiler"] }]]);
	});

	it("should hold until the session ends, and give up when its signal aborts first", async () => {
		expect.assertions(2);

		const ended = await joinAsync({});
		const session = await ended.joined;
		const holding = session!.holdAsync(openSignal(), 1000);
		await ended.fake.stop();
		const stop = new AbortController();
		stop.abort();
		const given = await joinAsync({}, stop.signal);

		await expect(holding).resolves.toBeUndefined();
		await expect(given.joined).resolves.toBeUndefined();
	});

	it.for([
		["own", { join: { added: ["syncback"], sessionId: "s1", taken: [] } }],
		["release", { leave: { stopped: ["studio"] } }],
	] as const)(
		"should reject an answer to %s that it cannot read as internal_error",
		async ([method, answers]) => {
			expect.assertions(1);

			const { joined } = await joinAsync(answers);
			const outcome = joined.then(async (session) => session!.holdAsync(released(), 1000));

			await expect(outcome).rejects.toMatchObject({
				code: "internal_error",
				message: `The session answered ${method} with something else.`,
			});
		},
	);
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
