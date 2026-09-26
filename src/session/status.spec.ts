import { describe, expect, it, vi } from "vitest";

import type { SessionStatus, StatusStart } from "./status.ts";
import { createStatusStore, isReady, parseStatus } from "./status.ts";

const NOW = Date.UTC(2026, 0, 1);
const AT = "2026-01-01T00:00:00.000Z";
const START: StatusStart = {
	compiler: true,
	open: true,
	pid: 42,
	port: 34_872,
	sessionId: "s1",
	startedAt: AT,
	syncback: true,
};

function makeStore(start: StatusStart = START) {
	const onChange = vi.fn<(status: SessionStatus) => void>();
	const store = createStatusStore(start, () => NOW, onChange);
	return { onChange, store };
}

describe(createStatusStore, () => {
	it("should start with every planned service starting and the rest off", () => {
		expect.assertions(2);

		const { store } = makeStore();
		const { store: bare } = makeStore({
			...START,
			compiler: false,
			open: false,
			syncback: false,
		});

		expect(store.snapshot()).toStrictEqual({
			phase: "starting",
			pid: 42,
			running: true,
			services: {
				compiler: { building: false, status: "starting" },
				rojo: { port: 34_872, status: "starting" },
				studio: { status: "opening" },
				syncback: { status: "idle" },
			},
			sessionId: "s1",
			startedAt: AT,
		});
		expect(bare.snapshot().services).toStrictEqual({
			compiler: { building: false, status: "off" },
			rojo: { port: 34_872, status: "starting" },
			studio: { status: "off" },
			syncback: { status: "off" },
		});
	});

	it("should be ready once Rojo serves and the compiler finished its first compile", () => {
		expect.assertions(3);

		const { onChange, store } = makeStore();
		store.service("rojo", "ready");
		const withRojo = store.snapshot().phase;
		store.compiled({ at: AT, diagnostics: [], errors: 0, startedAt: AT }, false);

		expect(withRojo).toBe("starting");
		expect(store.snapshot().services.compiler).toStrictEqual({
			building: false,
			lastBuild: { at: AT, diagnostics: [], errors: 0, startedAt: AT },
			status: "ready",
		});
		expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "ready" }));
	});

	it("should tell while a compile runs, and whether one still runs after a build", () => {
		expect.assertions(3);

		const { onChange, store } = makeStore();
		store.building(true);
		const building = store.snapshot().services.compiler;
		store.compiled({ at: AT, diagnostics: [], errors: 0, startedAt: AT }, true);
		const isStillBuilding = store.snapshot().services.compiler.building;
		store.compiled({ at: AT, diagnostics: [], errors: 0, startedAt: AT }, false);

		expect(building).toStrictEqual({ building: true, status: "starting" });
		expect(isStillBuilding).toBeTrue();
		expect(onChange.mock.lastCall![0].services.compiler).toStrictEqual({
			building: false,
			lastBuild: { at: AT, diagnostics: [], errors: 0, startedAt: AT },
			status: "ready",
		});
	});

	it("should be ready with Rojo alone when there is no compiler", () => {
		expect.assertions(1);

		const { store } = makeStore({ ...START, compiler: false });
		store.service("rojo", "ready");

		expect(isReady(store.snapshot())).toBeTrue();
	});

	it("should start with Rojo off and no port, and be ready with the compiler alone", () => {
		expect.assertions(3);

		const { store } = makeStore({ ...START, port: null });
		const before = store.snapshot();
		store.compiled({ at: AT, diagnostics: [], errors: 0, startedAt: AT }, false);

		expect(before.services.rojo).toStrictEqual({ port: null, status: "off" });
		expect(before.phase).toBe("starting");
		expect(isReady(store.snapshot())).toBeTrue();
	});

	it("should read back a status with Rojo off", () => {
		expect.assertions(1);

		const { store } = makeStore({ ...START, port: null });
		const status = store.snapshot();

		expect(parseStatus(JSON.parse(JSON.stringify(status)))).toStrictEqual(status);
	});

	it("should keep the phase it is told once the session ends", () => {
		expect.assertions(3);

		const { store } = makeStore({ ...START, compiler: false });
		store.phase("stopping");
		store.service("rojo", "ready");
		const stopping = store.snapshot();
		store.phase("stopped");

		expect(stopping.phase).toBe("stopping");
		expect(stopping.running).toBeTrue();
		expect(store.snapshot()).toMatchObject({ phase: "stopped", running: false });
	});

	it("should tell every phase change", () => {
		expect.assertions(1);

		const { onChange, store } = makeStore();
		store.phase("stopped");

		expect(onChange).toHaveBeenLastCalledWith(
			expect.objectContaining({ phase: "stopped", running: false }),
		);
	});

	it("should not be ready while Rojo starts, even after a compile", () => {
		expect.assertions(1);

		const { store } = makeStore();
		store.compiled({ at: AT, diagnostics: [], errors: 0, startedAt: AT }, false);

		expect(store.snapshot().phase).toBe("starting");
	});

	it("should record syncback runs and Studio", () => {
		expect.assertions(3);

		const { store } = makeStore();
		store.syncbackStarted();
		const running = store.snapshot().services.syncback.status;
		store.syncbackFinished({ durationMs: 5, hooks: [], ok: true });
		store.studio("open", "/project/game.rbxl", null);

		expect(running).toBe("running");
		expect(store.snapshot().services.syncback).toStrictEqual({
			lastRun: { at: AT, durationMs: 5, hooks: [], ok: true },
			status: "idle",
		});
		expect(store.snapshot().services.studio).toStrictEqual({
			place: "/project/game.rbxl",
			status: "open",
		});
	});

	it("should record the Studio forge started", () => {
		expect.assertions(1);

		const { store } = makeStore();
		store.studio("opening", "/project/game.rbxl", { pid: 7, startTime: "70" });

		expect(parseStatus(store.snapshot())!.services.studio).toStrictEqual({
			pid: 7,
			place: "/project/game.rbxl",
			startTime: "70",
			status: "opening",
		});
	});

	it("should keep syncback off after a forge sync run in a session without the save watch", () => {
		expect.assertions(2);

		const { store } = makeStore({ ...START, syncback: false });
		store.syncbackStarted();
		const running = store.snapshot().services.syncback.status;
		store.syncbackFinished({ durationMs: 5, hooks: [], ok: true });

		expect(running).toBe("running");
		expect(store.snapshot().services.syncback).toStrictEqual({
			lastRun: { at: AT, durationMs: 5, hooks: [], ok: true },
			status: "off",
		});
	});

	it("should hand out copies", () => {
		expect.assertions(2);

		const { onChange, store } = makeStore();
		store.snapshot().services.rojo.port = 1;
		store.studio("closed", "/project/game.rbxl", null);
		onChange.mock.calls[0]![0].services.rojo.port = 2;

		expect(store.snapshot().services.rojo.port).toBe(34_872);
		expect(onChange).toHaveBeenCalledOnce();
	});
});

describe(parseStatus, () => {
	it("should read a status back, and nothing else", () => {
		expect.assertions(3);

		const { store } = makeStore();
		store.compiled(
			{
				at: AT,
				diagnostics: [
					{
						code: "TS1",
						column: 2,
						file: "src/a.ts",
						line: 1,
						message: "m",
						severity: "error",
					},
				],
				errors: 1,
				startedAt: AT,
			},
			true,
		);
		store.syncbackFinished({
			durationMs: 1,
			error: { code: "hook_failed", message: "m" },
			hooks: [
				{
					id: "syncback:post:0",
					command: "lint",
					durationMs: 1,
					exitCode: 1,
					ok: false,
					outcome: "failed",
					outputTail: ["x"],
				},
			],
			ok: false,
		});
		const status = JSON.parse(JSON.stringify(store.snapshot())) as unknown;

		expect(parseStatus(status)).toStrictEqual(store.snapshot());
		expect(parseStatus({ running: true })).toBeUndefined();
		expect(parseStatus("status")).toBeUndefined();
	});
});
