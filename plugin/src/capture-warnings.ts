/** An edited service property a capture cannot carry into syncback. */
export interface CaptureWarning {
	property: string;
	reason: "collision_groups" | "material_override" | "unreadable";
	service: string;
}

/**
 * Engine observations used to name changes without reading protected values.
 */
export interface WarningIo {
	collisionGroups: () => Array<{ mask: number; name: string }>;
	materialOverrides: () => Map<string, string>;
	onFrame: (callback: () => void) => Disconnect;
	onRedo: (callback: (name: string) => void) => Disconnect;
	onUndo: (callback: (name: string) => void) => Disconnect;
	selectedServices: () => Array<string>;
	services: Array<{
		name: string;
		onChanged: (callback: (property: string) => void) => Disconnect;
		unreadable: Array<string>;
	}>;
	undoWaypoint: () => string | undefined;
}

/** A session's change observers and the warnings for its next capture. */
export interface CaptureWarnings {
	capture: () => Array<CaptureWarning>;
	close: () => void;
	resume: () => void;
}

type Disconnect = () => void;

interface WarningQueue {
	drain: () => Array<CaptureWarning>;
	record: (service: string, property: string, reason?: CaptureWarning["reason"]) => void;
}

/**
 * Observe changes for one forge session, returning each property once.
 * @param io - The runtime unreadable split and engine observations.
 * @returns The session's warning collector and cleanup.
 */
export function observeCaptureWarnings(io: WarningIo): CaptureWarnings {
	const queue = createWarningQueue();
	const baseline = new Map(io.collisionGroups().map((group) => [group.name, group.mask]));
	const captureMaterials = observeMaterialOverrides(io, queue.record);
	const changes = observeResumableChanges(io, queue.record);
	return {
		...changes,
		capture: () => {
			const groups = io.collisionGroups();
			if (
				groups.size() !== baseline.size() ||
				groups.some((group) => baseline.get(group.name) !== group.mask)
			) {
				queue.record("Workspace", "CollisionGroups", "collision_groups");
			}

			captureMaterials();
			return queue.drain();
		},
	};
}

function matchWaypoint(
	io: WarningIo,
	name: string,
	record: (service: string, property: string) => void,
): void {
	for (const service of io.services) {
		if (!io.selectedServices().includes(service.name)) {
			continue;
		}

		for (const property of service.unreadable) {
			if (string.find(name, property, 1, true)[0] !== undefined) {
				record(service.name, property);
			}
		}
	}
}

function observeChanges(
	io: WarningIo,
	record: (service: string, property: string) => void,
): Array<Disconnect> {
	const match = (name: string): void => {
		matchWaypoint(io, name, record);
	};

	const connections = io.services.map((service) => {
		return service.onChanged((property) => {
			if (service.unreadable.includes(property)) {
				record(service.name, property);
			}
		});
	});
	connections.push(
		io.onFrame(() => {
			match(io.undoWaypoint() ?? "");
		}),
		io.onUndo(match),
		io.onRedo(match),
	);
	return connections;
}

function observeUnreadableChanges(
	io: WarningIo,
	record: WarningQueue["record"],
): Array<Disconnect> {
	const materials = io.materialOverrides();
	return observeChanges(io, (service, property) => {
		if (service === "Workspace" && property === "CollisionGroups") {
			return;
		}

		if (service !== "MaterialService" || !materials.has(property)) {
			record(service, property);
		}
	});
}

function observeResumableChanges(
	io: WarningIo,
	record: WarningQueue["record"],
): Pick<CaptureWarnings, "close" | "resume"> {
	let connections = observeUnreadableChanges(io, record);
	return {
		close: () => {
			for (const disconnect of connections) {
				disconnect();
			}

			connections = [];
		},
		resume: () => {
			if (connections.isEmpty()) {
				connections = observeUnreadableChanges(io, record);
			}
		},
	};
}

function observeMaterialOverrides(io: WarningIo, record: WarningQueue["record"]): () => void {
	const baseline = table.clone(io.materialOverrides());
	return () => {
		// oxlint-disable-next-line unicorn/no-array-for-each -- Roblox maps use the forEach macro
		io.materialOverrides().forEach((value, property) => {
			if (baseline.get(property) !== value) {
				record("MaterialService", property, "material_override");
			}
		});
	};
}

function createWarningQueue(): WarningQueue {
	let warnings = new Array<CaptureWarning>();
	const seen = new Set<string>();
	return {
		drain: () => {
			const pending = warnings;
			warnings = [];
			return pending;
		},
		record: (service, property, reason: CaptureWarning["reason"] = "unreadable"): void => {
			const key = `${service}.${property}`;
			if (seen.has(key)) {
				return;
			}

			seen.add(key);
			warnings.push({ property, reason, service });
		},
	};
}
