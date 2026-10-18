import { describe, expect, it } from "@rbxts/jest-globals";

import type { WarningIo } from "./capture-warnings";
import { createWarningSession } from "./warning-session";

function captureConfig(forge: string | undefined, generation: string): Configuration {
	const capture = new Instance("Configuration");
	capture.SetAttribute("ForgeSessionId", forge);
	capture.SetAttribute("SessionId", generation);
	return capture;
}

function sessionFixture() {
	const overrides = new Map([["GrassName", "OriginalGrass"]]);
	const groups = [{ name: "Default", mask: 1 }];
	const io: WarningIo = {
		collisionGroups: () => groups,
		materialOverrides: () => overrides,
		onFrame: () => () => {},
		onRedo: () => () => {},
		onUndo: () => () => {},
		selectedServices: () => [],
		services: [],
		undoWaypoint: (): undefined => {},
	};
	return { groups, overrides, session: createWarningSession(() => io) };
}

describe("warning session", () => {
	it.each([
		{ firstId: "forge-a", kind: "forge", subsequentId: "forge-b" },
		{ firstId: undefined, kind: "legacy", subsequentId: undefined },
	])("should reset the baseline for a new $kind session", ({ firstId, subsequentId }) => {
		expect.assertions(2);

		const { overrides, session } = sessionFixture();
		session.update(undefined);
		session.close();
		const first = session.update(captureConfig(firstId, "generation-1"));
		assert(first !== undefined);
		overrides.set("GrassName", "EditedGrass");
		first.capture();
		const subsequent = session.update(captureConfig(subsequentId, "generation-2"));
		assert(subsequent !== undefined);
		const baseline = subsequent.capture();
		overrides.set("GrassName", "NewSessionEdit");
		const edited = subsequent.capture();
		session.close();

		expect(baseline).toHaveLength(0);
		expect(edited.map((warning) => warning.property).join(",")).toBe("GrassName");
	});

	it("should keep its baseline and reported properties through a Rojo reconnect", () => {
		expect.assertions(4);

		const { groups, overrides, session } = sessionFixture();
		const initial = session.update(captureConfig("forge-a", "generation-1"));
		assert(initial !== undefined);
		overrides.set("GrassName", "EditedGrass");
		const first = initial.capture();
		const disconnected = session.update(undefined);
		groups.push({ name: "EditedGroup", mask: 3 });
		const resumed = session.update(captureConfig("forge-a", "generation-2"));
		assert(resumed !== undefined);
		const afterReconnect = resumed.capture();
		overrides.set("GrassName", "EditedAgain");
		const repeated = resumed.capture();
		session.close();

		expect(first.map((warning) => warning.property).join(",")).toBe("GrassName");
		expect(disconnected).toBeUndefined();
		expect(afterReconnect.map((warning) => warning.property).join(",")).toBe("CollisionGroups");
		expect(repeated).toHaveLength(0);
	});
});
