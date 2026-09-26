import { ForgeError } from "../errors.ts";
import type { CommandResult } from "../seams/reporter.ts";
import type { PartAdder, PartRequest } from "./part-requests.ts";
import { isPartRunning } from "./part-stops.ts";
import type { SessionScope } from "./run-session.ts";
import type { ServiceParts } from "./service-parts.ts";
import type { PartId, ServiceId, SessionStatus, StatusStore } from "./status.ts";
import type { StopRequest } from "./stop-source.ts";
import type { StudioState } from "./studio-part.ts";
import { leaveStudio } from "./studio-part.ts";

/** Who holds the session now. */
export interface Ownership {
	/** The parts the owner started; the rest of what it owns, it took. */
	added: Set<PartId>;
	/**
	 * A `start` holds the session: the one that started it (the owner pipe)
	 * or one that joined it (`own`).
	 */
	isOwned: boolean;
}

/** What a `start` that joined took and started. */
export interface OwnerJoin {
	/** The parts it started, in order. */
	added: Array<PartId>;
	/** The running parts it took from nobody. */
	taken: Array<PartId>;
}

/** What the end of an owner did. */
export interface OwnerRelease {
	/** No part with no owner is left: the session ends. */
	ending: boolean;
	/** The parts it took, which run on with no owner. */
	released: Array<PartId>;
	sessionId: string;
	/** The services it started, now stopped. */
	stopped: Array<ServiceId>;
	/** The session let go of the Studio it opened, which stays open. */
	studioLeft: boolean;
}

/** What an owner's end does to each part it owns. */
export interface ReleasePlan {
	/** Every owned part: each loses its owner. */
	clear: Array<PartId>;
	/** A part runs on after it: the session goes on. */
	isKept: boolean;
	/** The running parts it took: they run on with no owner. */
	release: Array<PartId>;
	/** The running parts it started: they stop, and Studio is let go. */
	stop: Array<PartId>;
}

/** Joins an owner, and ends one. */
export interface OwnerHandlers {
	/**
	 * A `start` joins: it takes every running part (only the compiler when
	 * it asks for no Studio), then starts the parts it asks for that are
	 * missing or failed.
	 *
	 * @rejects {ForgeError} `session_running` while another `start` holds
	 *   the session; the add's failure, once what it took is given back.
	 */
	own: (request: PartRequest) => Promise<OwnerJoin>;
	/**
	 * The owner is gone (Ctrl+C, a closed terminal, a closed connection):
	 * stop the parts it started, and give back those it took. The session ends
	 * with `reason` when no part is left to run on.
	 */
	release: (reason: StopRequest) => Promise<OwnerRelease>;
}

/** What the owner handlers change. */
export interface OwnerParts {
	/** Starts the parts a join asks for. */
	add: PartAdder;
	ownership: Ownership;
	parts: Pick<ServiceParts, "stopAsync">;
	studio: StudioState;
}

/** What the owner handlers read and record. */
export interface OwnerSetup {
	status: Pick<StatusStore, "owner" | "phase" | "snapshot" | "studioLeft">;
}

const PART_IDS: ReadonlyArray<PartId> = ["studio", "rojo", "compiler"];

const PART_NAMES: Readonly<Record<PartId, string>> = {
	compiler: "the compiler",
	rojo: "Rojo",
	studio: "Studio",
};

/**
 * Decide what an owner's end does: the running parts it started stop
 * (Studio is let go, never closed), the running parts it took run on with
 * no owner. The session goes on while any part is left that runs with no
 * owner after it.
 *
 * @param services - The parts' status and owners.
 * @param added - The parts the owner started.
 * @returns What to stop, give back, and clear, Studio first.
 */
export function planRelease(
	services: SessionStatus["services"],
	added: ReadonlySet<PartId>,
): ReleasePlan {
	const plan: ReleasePlan = { clear: [], isKept: false, release: [], stop: [] };
	for (const part of PART_IDS) {
		const isOwned = services[part].owner !== null;
		if (isOwned) {
			plan.clear.push(part);
		}

		if (!isPartRunning(services, part)) {
			continue;
		}

		if (isOwned && added.has(part)) {
			plan.stop.push(part);
		} else {
			plan.isKept = true;
			if (isOwned) {
				plan.release.push(part);
			}
		}
	}

	return plan;
}

/**
 * The result of a `start` whose end let go of a session.
 *
 * @param release - What its end did, in which session.
 * @returns The result, and a summary that names each part.
 */
export function releasedResult(release: OwnerRelease): CommandResult {
	const done: Array<string> = [];
	if (release.stopped.length > 0) {
		done.push(`stopped ${partNames(release.stopped)}`);
	}

	if (release.studioLeft) {
		done.push("left Studio open");
	}

	if (release.released.length > 0) {
		const verb = release.released.length === 1 ? "runs" : "run";
		done.push(`${partNames(release.released)} ${verb} on with no owner`);
	}

	const did = done.length === 0 ? "it owned no part" : done.join("; ");
	const end = release.ending ? " No part is left, so the session ends." : "";
	return {
		data: { ...release },
		summary: `Let go of session ${release.sessionId}: ${did}.${end}`,
	};
}

/**
 * Make the handlers that join an owner and end one. At most one owner holds
 * the session at a time.
 *
 * @param setup - The status the handlers read and record owners in.
 * @param scope - Where the session's end goes.
 * @param owner - The adder, the ownership, the parts, and the Studio.
 * @returns What joins an owner, and what ends it.
 */
export function createOwnerHandlers(
	setup: OwnerSetup,
	scope: Pick<SessionScope, "end">,
	owner: OwnerParts,
): OwnerHandlers {
	async function releaseAsync(reason: StopRequest): Promise<OwnerRelease> {
		return endOwnerAsync(setup, scope, owner, reason);
	}

	return {
		own: async (request) => joinOwnerAsync(setup, owner, { release: releaseAsync, request }),
		release: releaseAsync,
	};
}

function partNames(parts: ReadonlyArray<PartId>): string {
	return parts.map((part) => PART_NAMES[part]).join(" and ");
}

/**
 * A `start` joins as the owner: take every running part (only the
 * compiler when it asks for no Studio), then start the parts it asks for,
 * and own them too.
 *
 * @param setup - The status.
 * @param owner - The adder and the ownership.
 * @param join - The request, and what gives back what it took when the add
 *   fails.
 * @param join.release - Ends the owner.
 * @param join.request - The parts to start.
 * @returns What it took and started.
 * @rejects As {@link OwnerHandlers.own}.
 */
async function joinOwnerAsync(
	{ status }: OwnerSetup,
	{ add, ownership }: OwnerParts,
	join: { release: OwnerHandlers["release"]; request: PartRequest },
): Promise<OwnerJoin> {
	const { services, sessionId } = status.snapshot();
	if (ownership.isOwned) {
		throw new ForgeError(
			"session_running",
			`Session ${sessionId} already has an owner: a forge start terminal.`,
			{ hint: 'Stop that forge start first, or use "forge up".' },
		);
	}

	ownership.isOwned = true;
	// `start --no-open` owns only the compiler: Studio and its Rojo stay.
	const reach = join.request.parts.includes("studio") ? PART_IDS : ["compiler" as const];
	const taken = reach.filter((part) => isPartRunning(services, part));
	for (const part of taken) {
		status.owner(part, "start");
	}

	let added: Array<PartId>;
	try {
		added = await add(join.request);
	} catch (err) {
		await join.release({ type: "owner_gone" });
		throw err;
	}

	for (const part of added) {
		ownership.added.add(part);
		status.owner(part, "start");
	}

	return { added, taken };
}

/**
 * The owner is gone: stop the parts it started and let go of its Studio,
 * give back the parts it took, or end the session when none runs on.
 *
 * @param setup - The status.
 * @param scope - Where the session's end goes.
 * @param owner - The ownership, the parts, and the Studio.
 * @param reason - Why the owner is gone: the session's end reason.
 * @returns What the end did.
 */
async function endOwnerAsync(
	{ status }: OwnerSetup,
	scope: Pick<SessionScope, "end">,
	{ ownership, parts, studio }: OwnerParts,
	reason: StopRequest,
): Promise<OwnerRelease> {
	const { services, sessionId } = status.snapshot();
	const none = { ending: false, released: [], sessionId, stopped: [], studioLeft: false };
	if (!ownership.isOwned) {
		return none;
	}

	ownership.isOwned = false;
	const plan = planRelease(services, ownership.added);
	ownership.added.clear();
	const stopped = plan.stop.filter((part): part is ServiceId => part !== "studio");
	const isStudioLeft = plan.stop.includes("studio");
	if (!plan.isKept) {
		status.phase("stopping");
		scope.end(reason);
		return { ...none, ending: true, stopped, studioLeft: isStudioLeft };
	}

	for (const part of plan.clear) {
		status.owner(part, null);
	}

	if (isStudioLeft) {
		leaveStudio(studio, status);
	}

	for (const part of stopped) {
		await parts.stopAsync(part);
	}

	return { ...none, released: plan.release, stopped, studioLeft: isStudioLeft };
}
