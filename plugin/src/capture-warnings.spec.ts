import { describe, expect, it } from "@rbxts/jest-globals";

import { observeCaptureWarnings } from "./capture-warnings";
import type { WarningIo } from "./capture-warnings";

function connect(
	listeners: Array<(name: string) => void>,
	callback: (name: string) => void,
): () => void {
	listeners.push(callback);
	return () => {
		listeners.remove(listeners.indexOf(callback));
	};
}

function warningFixture(overrides: Partial<WarningIo> = {}) {
	const frames = new Array<() => void>();
	const undo = new Array<(name: string) => void>();
	const redo = new Array<(name: string) => void>();
	const changed = new Array<(name: string) => void>();
	const io: WarningIo = {
		collisionGroups: () => [{ name: "Default", mask: 1 }],
		materialOverrides: () => new Map(),
		onFrame: (callback) => {
			frames.push(callback);
			return () => {
				frames.remove(frames.indexOf(callback));
			};
		},
		onRedo: (callback) => connect(redo, callback),
		onUndo: (callback) => connect(undo, callback),
		selectedServices: () => ["Workspace"],
		services: [
			{
				name: "Workspace",
				onChanged: (callback) => connect(changed, callback),
				unreadable: ["StreamingTargetRadius"],
			},
		],
		undoWaypoint: () => "Set StreamingTargetRadius",
		...overrides,
	};
	function emit(listeners: Array<(name: string) => void>, name: string) {
		for (const callback of listeners) {
			callback(name);
		}
	}

	return {
		changed: (name: string) => {
			emit(changed, name);
		},
		frame: () => {
			for (const callback of frames) {
				callback();
			}
		},
		io,
		redo: (name: string) => {
			emit(redo, name);
		},
		undo: (name: string) => {
			emit(undo, name);
		},
	};
}

describe("capture warnings", () => {
	it("should resume detection while retaining properties already reported in the session", () => {
		expect.assertions(3);

		const fixture = warningFixture({ undoWaypoint: (): undefined => {} });
		const service = fixture.io.services[0];
		assert(service !== undefined);
		service.unreadable.push("PhysicsSteppingMethod");
		const tracker = observeCaptureWarnings(fixture.io);
		fixture.changed("StreamingTargetRadius");
		const first = tracker.capture();
		tracker.close();
		fixture.changed("PhysicsSteppingMethod");
		const inactive = tracker.capture();
		tracker.resume();
		tracker.resume();
		fixture.changed("StreamingTargetRadius");
		fixture.changed("PhysicsSteppingMethod");
		const resumed = tracker.capture();
		tracker.close();

		expect(first.map((warning) => warning.property).join(",")).toBe("StreamingTargetRadius");
		expect(inactive).toHaveLength(0);
		expect(resumed.map((warning) => warning.property).join(",")).toBe("PhysicsSteppingMethod");
	});

	it("should close once without disconnecting another observer on the same services", () => {
		expect.assertions(2);

		const fixture = warningFixture();
		const first = observeCaptureWarnings(fixture.io);
		first.close();
		const second = observeCaptureWarnings(fixture.io);
		first.close();
		fixture.frame();
		const closedWarnings = first.capture();
		const activeWarnings = second.capture();
		second.close();

		expect(closedWarnings).toHaveLength(0);
		expect(activeWarnings).toHaveLength(1);
	});

	it("should classify collision edits from the baseline even when Changed also fires", () => {
		expect.assertions(1);

		let groups = [{ name: "Default", mask: 1 }];
		const fixture = warningFixture({ collisionGroups: () => groups });
		const service = fixture.io.services[0];
		assert(service !== undefined);
		service.unreadable.push("CollisionGroups");
		const tracker = observeCaptureWarnings(fixture.io);
		groups = [{ name: "Default", mask: 3 }];
		fixture.changed("CollisionGroups");
		const warnings = tracker.capture();
		tracker.close();

		expect(
			warnings
				.map((warning) => `${warning.service}.${warning.property}:${warning.reason}`)
				.join(","),
		).toBe("Workspace.CollisionGroups:collision_groups");
	});

	it("should ignore a material edit restored to the session baseline before capture", () => {
		expect.assertions(1);

		const changed = new Array<(name: string) => void>();
		const overrides = new Map([["GrassName", "OriginalGrass"]]);
		const fixture = warningFixture({
			materialOverrides: () => overrides,
			services: [
				{
					name: "MaterialService",
					onChanged: (callback) => connect(changed, callback),
					unreadable: ["GrassName"],
				},
			],
		});
		const tracker = observeCaptureWarnings(fixture.io);
		overrides.set("GrassName", "EditedGrass");
		for (const callback of changed) {
			callback("GrassName");
		}

		overrides.set("GrassName", "OriginalGrass");
		const warnings = tracker.capture();
		tracker.close();

		expect(warnings).toHaveLength(0);
	});

	it("should name a changed material override once against the session baseline", () => {
		expect.assertions(3);

		const overrides = new Map([["GrassName", "OriginalGrass"]]);
		const fixture = warningFixture({ materialOverrides: () => overrides });
		const tracker = observeCaptureWarnings(fixture.io);
		const initial = tracker.capture();
		overrides.set("GrassName", "EditedGrass");
		const warnings = tracker.capture();
		const repeated = tracker.capture();
		tracker.close();

		expect(initial).toHaveLength(0);
		expect(
			warnings
				.map((warning) => `${warning.service}.${warning.property}:${warning.reason}`)
				.join(","),
		).toBe("MaterialService.GrassName:material_override");
		expect(repeated).toHaveLength(0);
	});

	it("should report changed collision groups once relative to the session baseline", () => {
		expect.assertions(5);

		let groups = [{ name: "Default", mask: 1 }];
		const fixture = warningFixture({ collisionGroups: () => groups });
		const tracker = observeCaptureWarnings(fixture.io);
		const initial = tracker.capture();
		groups = [
			{ name: "Default", mask: 1 },
			{ name: "ForgeGroup", mask: 3 },
		];
		const warnings = tracker.capture();
		const repeated = tracker.capture();
		tracker.close();

		expect([initial.size(), repeated.size()]).toStrictEqual([0, 0]);
		expect(warnings).toHaveLength(1);

		const warning = warnings[0];
		assert(warning !== undefined);

		expect(warning.service).toBe("Workspace");
		expect(warning.property).toBe("CollisionGroups");
		expect(warning.reason).toBe("collision_groups");
	});

	it("should name the selected service's unreadable property from the undo waypoint", () => {
		expect.assertions(4);

		const fixture = warningFixture();
		const tracker = observeCaptureWarnings(fixture.io);

		fixture.frame();
		const warnings = tracker.capture();
		tracker.close();

		expect(warnings).toHaveLength(1);

		const warning = warnings[0];
		assert(warning !== undefined);

		expect(warning.service).toBe("Workspace");
		expect(warning.property).toBe("StreamingTargetRadius");
		expect(warning.reason).toBe("unreadable");
	});

	it("should report each property once across frames and later captures", () => {
		expect.assertions(3);

		const fixture = warningFixture();
		const tracker = observeCaptureWarnings(fixture.io);
		fixture.frame();
		fixture.frame();
		const first = tracker.capture();
		const drained = tracker.capture();
		fixture.frame();
		const later = tracker.capture();
		tracker.close();

		expect(first).toHaveLength(1);
		expect(drained).toHaveLength(0);
		expect(later).toHaveLength(0);
	});

	it.each(["undo", "redo", "changed"] as const)(
		"should name an unreadable property from its %s signal",
		(signal) => {
			expect.assertions(3);

			const fixture = warningFixture({
				undoWaypoint: (): undefined => {},
			});
			const tracker = observeCaptureWarnings(fixture.io);
			fixture[signal]("StreamingTargetRadius");
			const warning = tracker.capture()[0];
			tracker.close();
			assert(warning !== undefined);

			expect(warning.service).toBe("Workspace");
			expect(warning.property).toBe("StreamingTargetRadius");
			expect(warning.reason).toBe("unreadable");
		},
	);

	it.each([
		{ selectedServices: () => [], selection: "none" },
		{ selectedServices: () => ["Workspace"], selection: "Workspace" },
	])(
		"should ignore readable and unrelated changes with selection $selection",
		({ selectedServices }) => {
			expect.assertions(1);

			const fixture = warningFixture({
				selectedServices,
				undoWaypoint: (): undefined => {},
			});
			const tracker = observeCaptureWarnings(fixture.io);
			fixture.changed("Brightness");
			fixture.undo("Move");
			fixture.frame();
			const warnings = tracker.capture();
			tracker.close();

			expect(warnings).toHaveLength(0);
		},
	);
});
