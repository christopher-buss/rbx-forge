import type { PinnedProcess } from "../../src/native/addon.ts";
import type { FakeProcess } from "./native.ts";

/**
 * Window visibility and watcher lifetime over the pinned fake identity.
 * @param entry - The pinned process.
 * @returns The Windows visibility members.
 */
export function windowMembers(
	entry: FakeProcess,
): Pick<
	PinnedProcess,
	"setWindowVisibility" | "startWindowHiding" | "stopWindowHiding" | "windowVisibility"
> {
	return {
		setWindowVisibility: (visibility) => {
			if (
				!entry.alive ||
				entry.windowVisibility === null ||
				entry.windowVisibility === undefined
			) {
				return false;
			}

			entry.windowVisibility = visibility === "hidden" ? "hidden" : "user";
			if (visibility !== "hidden") {
				entry.windowHiding = false;
			}

			return true;
		},
		startWindowHiding: () => {
			entry.windowHiding = entry.alive;
			return entry.alive;
		},
		stopWindowHiding: () => {
			const wasWatching = entry.alive && entry.windowHiding === true;
			entry.windowHiding = false;
			return wasWatching;
		},
		windowVisibility: () => (entry.alive ? (entry.windowVisibility ?? null) : null),
	};
}
