import { describe, it, vi } from "vitest";

import { makeStatus } from "../../test/helpers/fake-session.ts";
import { ForgeError } from "../errors.ts";
import type { AddablePart, PartAdder } from "./part-requests.ts";
import type { RestarterParts } from "./part-restarts.ts";
import { createPartRestarter, restartedParts } from "./part-restarts.ts";
import type { PartStopper, PartStops } from "./part-stops.ts";
import type { PartId, ServiceId, ServicePart, SessionStatus } from "./status.ts";

type Services = SessionStatus["services"];

function servicesWith(compiler: Partial<ServicePart> = {}): Services {
	const { services } = makeStatus();
	return { ...services, compiler: { ...services.compiler, ...compiler } };
}

const FAILED: Partial<ServicePart> = { owner: null, status: "failed" };
const OWNED_FAILED: Partial<ServicePart> = { owner: "start", status: "failed" };

describe(restartedParts, () => {
	it.for<[string, Services, Array<PartId>, boolean, Array<AddablePart>]>([
		["nothing when it stopped nothing", servicesWith(), [], false, []],
		[
			"the compiler first, then Studio, for every stopped part",
			servicesWith({ owner: null, status: "ready" }),
			["studio", "rojo", "compiler"],
			false,
			["compiler", "studio"],
		],
		[
			"Studio alone, whose Rojo the adder starts",
			servicesWith(),
			["studio", "rojo"],
			false,
			["studio"],
		],
		["a failed compiler with no owner", servicesWith(FAILED), [], false, ["compiler"]],
		["no failed compiler that has an owner", servicesWith(OWNED_FAILED), [], false, []],
		[
			"a failed compiler that has an owner, with force",
			servicesWith(OWNED_FAILED),
			[],
			true,
			["compiler"],
		],
		[
			"no Rojo alone, and no compiler that is off",
			servicesWith({ status: "off" }),
			["rojo"],
			true,
			[],
		],
	])("should restart %s", ([, services, stopped, force, expected], { expect }) => {
		expect.assertions(1);

		expect(restartedParts(services, stopped, force)).toStrictEqual(expected);
	});
});

/**
 * A restarter over fakes.
 *
 * @param stops - What the stop answers.
 * @param options - The parts before the stop, and the services whose trees
 *   left processes.
 * @param options.services - The parts before the stop.
 * @param options.survivors - The services whose trees left processes.
 * @returns The restarter and its fakes.
 */
function makeRestarter(
	stops: PartStops,
	{
		services = servicesWith(),
		survivors = [],
	}: { services?: Services; survivors?: ReadonlyArray<ServiceId> } = {},
) {
	const add = vi.fn<PartAdder>(async ({ parts }) => [...parts]);
	const stop = vi.fn<PartStopper>().mockResolvedValue(stops);
	const hasSurvivors = vi.fn<RestarterParts["parts"]["hasSurvivors"]>((id) => {
		return survivors.includes(id);
	});
	const snapshot = vi.fn<() => SessionStatus>(() => makeStatus({ services }));
	const restart = createPartRestarter(
		{ status: { snapshot } },
		{ add, parts: { hasSurvivors }, stop },
	);
	return { add, hasSurvivors, restart, stop };
}

const EVERY_PART: PartStops = {
	ending: false,
	kept: [],
	stopped: ["studio", "rojo", "compiler"],
	studio: { place: "/p/game.rbxl", stop: { status: "not_open" } },
};

describe(createPartRestarter, () => {
	it("should stop in the restart scope, then start the parts again, the compiler first", async ({
		expect,
	}) => {
		expect.assertions(3);

		const { add, restart, stop } = makeRestarter(EVERY_PART);

		await expect(
			restart({ force: true, recovery: "delete", studioPath: "/opt/Studio" }),
		).resolves.toStrictEqual({
			added: ["compiler", "studio"],
			kept: [],
			stopped: ["studio", "rojo", "compiler"],
			studio: EVERY_PART.studio,
		});
		expect(stop).toHaveBeenCalledExactlyOnceWith({
			force: true,
			keepStudio: false,
			recovery: "delete",
			scope: "restart",
		});
		expect(add).toHaveBeenCalledExactlyOnceWith({
			parts: ["compiler", "studio"],
			studioPath: "/opt/Studio",
		});
	});

	it("should say Studio did not open again when the compiler's first build fails", async ({
		expect,
	}) => {
		expect.assertions(1);

		const { add, restart } = makeRestarter(EVERY_PART);
		add.mockRejectedValue(
			new ForgeError("compile_timeout", "No fresh build within 300 s.", { hint: "Logs." }),
		);

		await expect(restart({ force: false })).rejects.toMatchObject({
			code: "compile_timeout",
			hint: "Logs.",
			message: "No fresh build within 300 s. forge did not open Studio again.",
		});
	});

	it("should pass an add's failure on as it is when it starts no Studio", async ({ expect }) => {
		expect.assertions(1);

		const failure = new ForgeError("compiler_missing", "No compiler.");
		const { add, restart } = makeRestarter({ ...EVERY_PART, stopped: ["compiler"] });
		add.mockRejectedValue(failure);

		await expect(restart({ force: false })).rejects.toBe(failure);
	});

	it("reopens Studio with its recorded hidden visibility", async ({ expect }) => {
		expect.assertions(1);

		const services = servicesWith();
		services.studio = {
			...services.studio,
			desktop: "hidden",
			origin: "forge",
			status: "open",
		};
		const { add, restart } = makeRestarter(EVERY_PART, { services });
		await restart({ force: false });

		expect(add).toHaveBeenCalledExactlyOnceWith({
			desktop: "hidden",
			parts: ["compiler", "studio"],
		});
	});

	it("should add nothing and keep the owned parts when it stopped nothing", async ({
		expect,
	}) => {
		expect.assertions(2);

		const kept: PartStops["kept"] = [{ owner: "start", part: "compiler" }];
		const { add, restart } = makeRestarter({ ending: false, kept, stopped: [] });

		await expect(restart({ force: false })).resolves.toStrictEqual({
			added: [],
			kept,
			stopped: [],
		});
		expect(add).not.toHaveBeenCalled();
	});

	it("should start nothing, not even a failed compiler, when it cannot close Studio", async ({
		expect,
	}) => {
		expect.assertions(2);

		const studio = {
			error: { code: "identity_mismatch", message: "Not Studio." },
			place: "/p/game.rbxl",
		};
		const { add, restart } = makeRestarter(
			{ ending: false, kept: [], stopped: [], studio },
			{ services: servicesWith(FAILED) },
		);

		await expect(restart({ force: false })).resolves.toStrictEqual({
			added: [],
			kept: [],
			stopped: [],
			studio,
		});
		expect(add).not.toHaveBeenCalled();
	});

	it("should start Rojo again for a found Studio that stays", async ({ expect }) => {
		expect.assertions(2);

		const { add, restart } = makeRestarter({
			ending: false,
			foundStudio: true,
			kept: [],
			stopped: ["rojo"],
		});
		add.mockResolvedValueOnce(["rojo"]);

		await expect(restart({ force: false })).resolves.toStrictEqual({
			added: ["rojo"],
			foundStudio: true,
			kept: [],
			stopped: ["rojo"],
		});
		expect(add).toHaveBeenCalledExactlyOnceWith({ parts: [], studioPath: undefined });
	});

	it("should start a failed compiler with no owner again", async ({ expect }) => {
		expect.assertions(1);

		const { add, restart } = makeRestarter(
			{ ending: false, kept: [], stopped: [] },
			{ services: servicesWith(FAILED) },
		);
		await restart({ force: false });

		expect(add).toHaveBeenCalledExactlyOnceWith({ parts: ["compiler"], studioPath: undefined });
	});

	it("should start nothing when a stopped service's tree left processes", async ({ expect }) => {
		expect.assertions(3);

		const { add, hasSurvivors, restart } = makeRestarter(EVERY_PART, {
			survivors: ["compiler"],
		});

		await expect(restart({ force: false })).rejects.toMatchObject({
			code: "cleanup_in_progress",
			details: { parts: ["compiler"] },
			hint: 'Run "forge restart" again once they are gone, or "forge down --force".',
			message:
				"Processes of compiler are still alive after the wait bound, so forge started nothing again.",
		});
		expect(add).not.toHaveBeenCalled();
		expect(hasSurvivors.mock.calls).toStrictEqual([["rojo"], ["compiler"]]);
	});

	it("should name every service whose tree left processes", async ({ expect }) => {
		expect.assertions(1);

		const { restart } = makeRestarter(EVERY_PART, { survivors: ["rojo", "compiler"] });

		await expect(restart({ force: false })).rejects.toMatchObject({
			details: { parts: ["rojo", "compiler"] },
			message:
				"Processes of rojo and compiler are still alive after the wait bound, so forge started nothing again.",
		});
	});
});
