import type { AutoRecoveryMode } from "../config/schema.ts";
import { ForgeError } from "../errors.ts";
import type { AddablePart, PartAdder } from "./part-requests.ts";
import type { KeptPart, PartStopper, StudioOutcome } from "./part-stops.ts";
import type { ServiceParts } from "./service-parts.ts";
import type { PartId, ServiceId, SessionStatus, StatusStore } from "./status.ts";

/** What one `restartParts` request asks for. */
export interface RestartRequest {
	/** Restart owned parts too (`restart --force`). */
	readonly force: boolean;
	/** What to do with the auto-recovery files of the Studio it closes. */
	readonly recovery?: AutoRecoveryMode | undefined;
	/** The Studio executable to start again, absolute. */
	readonly studioPath?: string | undefined;
}

/** What one restart did. */
export interface PartRestarts {
	/** The parts it started again, in order. */
	added: Array<PartId>;
	kept: Array<KeptPart>;
	/** The parts it stopped, in order. */
	stopped: Array<PartId>;
	/** What closing the session's Studio did, when it tried. */
	studio?: StudioOutcome;
}

/** Stops the parts a restart may touch, and starts them again. */
export type PartRestarter = (request: RestartRequest) => Promise<PartRestarts>;

/** What a restart stops and starts parts with. */
export interface RestarterParts {
	/** Starts parts; a part keeps the owner it had. */
	add: PartAdder;
	parts: Pick<ServiceParts, "hasSurvivors">;
	stop: PartStopper;
}

/**
 * The parts a restart starts again: those it stopped, and a failed compiler
 * that has no owner (or any, with `force`). Rojo comes with Studio, and the
 * adder starts it again for a Studio that stays.
 *
 * @param services - The parts before the stop.
 * @param services.compiler - The compiler's status and owner.
 * @param stopped - The parts the stop stopped.
 * @param force - Whether owned parts count too.
 * @returns The parts to add, the compiler first.
 */
export function restartedParts(
	{ compiler }: SessionStatus["services"],
	stopped: ReadonlyArray<PartId>,
	force: boolean,
): Array<AddablePart> {
	const isFailed = compiler.status === "failed" && (force || compiler.owner === null);
	const parts: Array<AddablePart> = isFailed || stopped.includes("compiler") ? ["compiler"] : [];
	return stopped.includes("studio") ? [...parts, "studio"] : parts;
}

/**
 * Make the restarter of a session's parts (`forge restart`):
 *
 * 1. Stop the parts it may touch (`stopParts`, scope `restart`): Studio is
 *    closed, and each service is stopped until the reaper reports its tree
 *    gone.
 * 2. Start nothing when a stopped service left processes the reaper could
 *    not prove gone.
 * 3. Start the parts again through the adder: the compiler first, then
 *    Studio and Rojo once the compiler's first build is done. Each keeps
 *    the owner it had.
 *
 * @param setup - The status, read before the stop.
 * @param restart - The adder, the service parts, and the stopper.
 * @returns The restarter the control channel calls.
 */
export function createPartRestarter(
	setup: { status: Pick<StatusStore, "snapshot"> },
	restart: RestarterParts,
): PartRestarter {
	return async ({ force, recovery, studioPath }) => {
		const { services } = setup.status.snapshot();
		const stops = await restart.stop({ force, keepStudio: false, recovery, scope: "restart" });
		requireGone(restart.parts, stops.stopped);
		// A Studio it cannot close holds the restart: nothing starts again.
		const isHeld = stops.studio !== undefined && "error" in stops.studio;
		const parts = isHeld ? [] : restartedParts(services, stops.stopped, force);
		const added = parts.length === 0 ? [] : await restart.add({ parts, studioPath });
		return {
			added,
			kept: stops.kept,
			stopped: stops.stopped,
			...(stops.studio === undefined ? {} : { studio: stops.studio }),
		};
	};
}

/**
 * Check that every stopped service's tree is gone.
 *
 * @param parts - Knows which trees left processes behind.
 * @param stopped - The parts a stop stopped.
 * @throws {ForgeError} `cleanup_in_progress` naming the services.
 */
function requireGone(parts: RestarterParts["parts"], stopped: ReadonlyArray<PartId>): void {
	const left = stopped.filter((part): part is ServiceId => {
		return part !== "studio" && parts.hasSurvivors(part);
	});
	if (left.length === 0) {
		return;
	}

	throw new ForgeError(
		"cleanup_in_progress",
		`Processes of ${left.join(" and ")} are still alive after the wait bound, so forge started nothing again.`,
		{
			details: { parts: left },
			hint: 'Run "forge restart" again once they are gone, or "forge down --force".',
		},
	);
}
