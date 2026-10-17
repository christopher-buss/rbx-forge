import { describe, expect, it } from "@rbxts/jest-globals";

import type { PluginIo } from "./capture";
import { observeCaptureWarnings } from "./capture-warnings";
import { createWarningIo } from "./warning-runtime";

function protectedLightingIo(
	history = game.GetService("ChangeHistoryService"),
): PluginIo["services"] {
	return {
		capabilityBits: () => [],
		history,
		isRunning: () => false,
		isSerialized: (name) => name === "Lighting",
		properties: () => [
			{ name: "Ambient", engineType: "Color3", serialized: true },
			{ name: "Brightness", engineType: "float", serialized: true },
			{ name: "Transient", engineType: "string", serialized: false },
		],
		readProperty: (_service, property) => {
			assert(property === "Brightness", `protected ${property}`);
			return 1;
		},
		serialize: () => buffer.create(0),
	};
}

function changedAmbient(original: Color3): Color3 {
	return new Color3(original.R < 0.5 ? 1 : 0, original.G, original.B);
}

function historyFixture(state: { canUndo: boolean; denied: boolean; name: string | undefined }) {
	const undo = new Instance("BindableEvent");
	const redo = new Instance("BindableEvent");
	const history: Partial<ChangeHistoryService> = {
		// eslint-disable-next-line roblox/no-user-defined-lua-tuple -- this seam models the engine's multiple return values
		GetCanUndo(this: ChangeHistoryService): LuaTuple<[boolean, string | undefined]> {
			assert(!state.denied, "history unavailable");
			// eslint-disable-next-line roblox/no-user-defined-lua-tuple -- preserve the engine ABI under the injected history
			return $tuple(state.canUndo, state.name);
		},
		OnRedo: redo.Event,
		OnUndo: undo.Event,
	};
	return {
		close: () => {
			undo.Destroy();
			redo.Destroy();
		},
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the metadata seam supplies only history reads and signals
		history: history as ChangeHistoryService,
		redo: (name: string) => {
			redo.Fire(name);
		},
		undo: (name: string) => {
			undo.Fire(name);
		},
	};
}

describe("runtime warning adapter", () => {
	it.each([
		{ name: "Set Ambient", canUndo: true, denied: false, expected: "Set Ambient" },
		{ name: "old waypoint", canUndo: false, denied: false, expected: undefined },
		{ name: undefined, canUndo: true, denied: false, expected: undefined },
		{ name: "Set Ambient", canUndo: true, denied: true, expected: undefined },
	])(
		"should preserve the history tuple (canUndo=$canUndo, denied=$denied)",
		({ name, canUndo, denied, expected }) => {
			expect.assertions(1);

			const history = historyFixture({ name, canUndo, denied });
			const io = createWarningIo(game, protectedLightingIo(history.history));
			const waypoint = io.undoWaypoint();
			history.close();

			expect(waypoint).toBe(expected);
		},
	);

	it("should relay Undo and Redo waypoints and release both subscriptions", () => {
		expect.assertions(1);

		const history = historyFixture({ name: undefined, canUndo: false, denied: false });
		const io = createWarningIo(game, protectedLightingIo(history.history));
		const trace = new Array<string>();
		const stopUndo = io.onUndo((name) => {
			trace.push(`undo:${name}`);
		});
		const stopRedo = io.onRedo((name) => {
			trace.push(`redo:${name}`);
		});
		history.undo("Set Ambient");
		history.redo("Set Brightness");
		task.wait(0.05);
		stopUndo();
		stopRedo();
		history.undo("disconnected");
		history.redo("disconnected");
		task.wait(0.05);
		history.close();

		expect(trace.join("|")).toBe("undo:Set Ambient|redo:Set Brightness");
	});

	it("should select serialized services and disconnect their Changed observer", () => {
		expect.assertions(2);

		const lighting = game.GetService("Lighting");
		const selection = game.GetService("Selection");
		const originalSelection = selection.Get();
		const original = lighting.Ambient;
		const nested = new Instance("Folder", game.GetService("Workspace"));
		const rootFolder = new Instance("Folder", game);
		const io = createWarningIo(game, protectedLightingIo());
		const service = io.services[0];
		assert(service !== undefined);
		const changes = new Array<string>();
		const stop = service.onChanged((property) => {
			changes.push(property);
		});
		selection.Set([lighting, nested, rootFolder]);
		const selected = io.selectedServices();
		lighting.Ambient = changedAmbient(original);
		task.wait(0.05);
		stop();
		lighting.Ambient = original;
		task.wait(0.05);
		selection.Set(originalSelection);
		nested.Destroy();
		rootFolder.Destroy();

		expect(selected.join("|")).toBe("Lighting");
		expect(changes.filter((property) => property === "Ambient")).toHaveLength(1);
	});

	it("should read collision group membership and changed masks from the engine", () => {
		expect.assertions(2);

		const physics = game.GetService("PhysicsService");
		const io = createWarningIo(game, protectedLightingIo());
		const name = "ForgeWarningRuntime";
		physics.RegisterCollisionGroup(name);
		const before = io.collisionGroups().find((group) => group.name === name);
		physics.CollisionGroupSetCollidable(name, "Default", false);
		const after = io.collisionGroups().find((group) => group.name === name);
		physics.UnregisterCollisionGroup(name);
		assert(before !== undefined);
		assert(after !== undefined);

		expect(after.name).toBe(name);
		expect(after.mask).never.toBe(before.mask);
	});

	it("should name material override properties and skip unsupported material entries", () => {
		expect.assertions(3);

		const materials = game.GetService("MaterialService");
		const original = materials.GetBaseMaterialOverride(Enum.Material.Grass);
		const variant = new Instance("MaterialVariant");
		variant.Name = "ForgeWarningRuntimeGrass";
		variant.BaseMaterial = Enum.Material.Grass;
		variant.Parent = materials;
		const io = createWarningIo(game, protectedLightingIo());
		const before = io.materialOverrides();
		materials.SetBaseMaterialOverride(Enum.Material.Grass, variant.Name);
		const after = io.materialOverrides();
		materials.SetBaseMaterialOverride(Enum.Material.Grass, original);
		variant.Destroy();

		expect(before.get("GrassName")).toBe(original);
		expect(after.get("GrassName")).toBe("ForgeWarningRuntimeGrass");
		expect(after.has("Grass")).toBeFalsy();
	});

	it("should trace protected serialized service changes and disconnect engine observers", () => {
		expect.assertions(3);

		const lighting = game.GetService("Lighting");
		const original = lighting.Ambient;
		const io = createWarningIo(game, protectedLightingIo());
		const tracker = observeCaptureWarnings(io);
		let frames = 0;
		const stopFrame = io.onFrame(() => {
			frames += 1;
		});
		lighting.Ambient = changedAmbient(original);
		task.wait(0.05);
		const warnings = tracker.capture();
		tracker.close();
		stopFrame();
		const stoppedAt = frames;
		lighting.Ambient = original;
		task.wait(0.05);

		expect(
			io.services
				.map((service) => `${service.name}:${service.unreadable.join(",")}`)
				.join("|"),
		).toBe("Lighting:Ambient");
		expect(
			warnings
				.map((warning) => `${warning.service}.${warning.property}:${warning.reason}`)
				.join("|"),
		).toBe("Lighting.Ambient:unreadable");
		expect([frames > 0, frames === stoppedAt, tracker.capture().size()]).toStrictEqual([
			true,
			true,
			0,
		]);
	});
});
