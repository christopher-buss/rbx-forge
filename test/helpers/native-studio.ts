import type { PinnedProcess } from "../../src/native/addon.ts";
import type { FakeProcess } from "./native.ts";

/**
 * The macOS app members of a pin: visibility and activation.
 *
 * @param table - The process table, whose apps one activation deactivates.
 * @param entry - The process.
 * @returns Those members.
 */
export function appMembers(
	table: ReadonlyMap<number, FakeProcess>,
	entry: FakeProcess,
): Pick<PinnedProcess, "activateApp" | "appActive" | "appHidden" | "setAppHidden"> {
	return {
		activateApp: () => activateApp(table, entry),
		appActive: () => (entry.alive ? entry.appActive === true : null),
		appHidden: () => appHidden(entry),
		setAppHidden: (hidden) => setAppHidden(entry, hidden),
	};
}

/**
 * Press the fake Save to File item as its scripted outcome says.
 *
 * @param entry - The pinned fake process.
 * @param timeoutMs - The time left; none reads `timeout`.
 * @returns The outcome.
 * @rejects Once the process has exited, or as scripted.
 */
export async function requestSaveAsync(
	entry: FakeProcess,
	timeoutMs = 30_000,
): Promise<"menu_disabled" | "no_menu_item" | "requested" | "timeout"> {
	await Promise.resolve();
	return timeoutMs <= 0 ? "timeout" : requestSave(entry);
}

/**
 * Poll the fake Save to File item: it enables at the scripted poll while
 * the app is active.
 *
 * @param entry - The pinned fake process.
 * @param timeoutMs - The time left; none reads `false`.
 * @returns Whether the item is enabled.
 * @rejects Once the process has exited.
 */
export async function saveMenuEnabledAsync(
	entry: FakeProcess,
	timeoutMs: number,
): Promise<boolean> {
	await Promise.resolve();
	if (!entry.alive) {
		throw new Error("Studio exited");
	}

	entry.saveMenuPolls = (entry.saveMenuPolls ?? 0) + 1;
	if (
		entry.appActive === true &&
		entry.saveMenuPolls >= (entry.saveMenuEnablesAtPoll ?? Infinity)
	) {
		entry.saveMenuDisabled = false;
	}

	return timeoutMs > 0 && entry.saveMenuDisabled !== true;
}

function appHidden(entry: FakeProcess): boolean | null {
	if (!entry.alive) {
		return null;
	}

	return entry.appHidden === undefined ? false : entry.appHidden;
}

function activateApp(table: ReadonlyMap<number, FakeProcess>, entry: FakeProcess): boolean {
	if (!entry.alive || entry.appHidden === null) {
		return false;
	}

	for (const other of table.values()) {
		other.appActive = false;
	}

	entry.activations = (entry.activations ?? 0) + 1;
	entry.appHidden = false;
	entry.appActive = true;
	return true;
}

function setAppHidden(entry: FakeProcess, hidden: boolean): boolean {
	if (!entry.alive || entry.refusesAppVisibility === true || entry.appHidden === null) {
		return false;
	}

	entry.appHidden = hidden;
	if (hidden) {
		entry.appActive = false;
	}

	return true;
}

function requestSave(
	entry: FakeProcess,
): "menu_disabled" | "no_menu_item" | "requested" | "timeout" {
	if (!entry.alive || entry.onSaveRequest === "throw") {
		throw new Error("Studio save failed");
	}

	if (entry.saveMenuDisabled === true) {
		return "menu_disabled";
	}

	if (entry.onSaveRequest === "no_menu_item") {
		return "no_menu_item";
	}

	if (entry.onSaveRequest === "timeout") {
		entry.onSave?.();
		return "timeout";
	}

	if (entry.onSaveRequest === "dialog") {
		entry.blocked = true;
	} else if (entry.onSaveRequest !== "ignore") {
		entry.onSave?.();
	}

	return "requested";
}
