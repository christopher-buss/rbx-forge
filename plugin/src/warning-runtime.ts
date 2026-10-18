// cspell:words pcall
import type { PluginIo } from "./capture";
import type { WarningIo } from "./capture-warnings";

interface UndoHistory extends ChangeHistoryService {
	// eslint-disable-next-line flawless/naming-convention -- matches the engine API
	GetCanUndo(this: ChangeHistoryService): LuaTuple<[boolean, string | undefined]>;
}

/**
 * Adapt runtime service reads and engine events to capture warnings.
 * @param root - The active data model.
 * @param metadataIo - Serialized class metadata and protected property reads.
 * @returns Warning baselines and event observers with cleanup.
 */
export function createWarningIo(root: DataModel, metadataIo: PluginIo["services"]): WarningIo {
	const physics = root.GetService("PhysicsService");
	const materials = root.GetService("MaterialService");
	const selection = root.GetService("Selection");
	const run = root.GetService("RunService");
	return {
		collisionGroups: () => physics.GetRegisteredCollisionGroups(),
		materialOverrides: () => materialOverrides(materials),
		onFrame: (callback) => disconnect(run.Heartbeat.Connect(callback)),
		onRedo: (callback) => disconnect(metadataIo.history.OnRedo.Connect(callback)),
		onUndo: (callback) => disconnect(metadataIo.history.OnUndo.Connect(callback)),
		selectedServices: () => selectedServiceNames(root, selection, metadataIo),
		services: serializedServices(root, metadataIo),
		undoWaypoint: () => undoWaypoint(metadataIo.history),
	};
}

function disconnect(connection: RBXScriptConnection): () => void {
	return () => {
		connection.Disconnect();
	};
}

function materialOverrides(service: MaterialService): Map<string, string> {
	const overrides = new Map<string, string>();
	for (const material of Enum.Material.GetEnumItems()) {
		const [canRead, name] = pcall(() => service.GetBaseMaterialOverride(material));
		if (canRead) {
			overrides.set(`${material.Name}Name`, name);
		}
	}

	return overrides;
}

function selectedServiceNames(
	root: DataModel,
	selection: Selection,
	metadataIo: PluginIo["services"],
): Array<string> {
	return selection
		.Get()
		.filter((service) => service.Parent === root && metadataIo.isSerialized(service.ClassName))
		.map((service) => service.ClassName);
}

function unreadableProperties(service: Instance, metadataIo: PluginIo["services"]): Array<string> {
	const unreadable = new Array<string>();
	for (const property of metadataIo.properties(service.ClassName)) {
		if (!property.serialized) {
			continue;
		}

		const [canRead] = pcall(() => metadataIo.readProperty(service, property.name));
		if (!canRead) {
			unreadable.push(property.name);
		}
	}

	return unreadable;
}

function serializedServices(
	root: DataModel,
	metadataIo: PluginIo["services"],
): WarningIo["services"] {
	return root
		.GetChildren()
		.filter((service) => metadataIo.isSerialized(service.ClassName))
		.map((service) => {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- serialized services emit property names
			const changed = (service as ChangedSignal & Instance).Changed;
			return {
				name: service.ClassName,
				onChanged: (callback) => disconnect(changed.Connect(callback)),
				unreadable: unreadableProperties(service, metadataIo),
			};
		});
}

function undoWaypoint(history: ChangeHistoryService): string | undefined {
	const [canRead, canUndo, name] = pcall(() => {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the engine returns a boolean and optional waypoint
		return (history as UndoHistory).GetCanUndo();
	});
	return canRead && canUndo ? name : undefined;
}
