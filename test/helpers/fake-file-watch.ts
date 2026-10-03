import { fromAny } from "@total-typescript/shoehorn";

import { EventEmitter } from "node:events";
import path from "node:path";
import { vi } from "vitest";

import type { FileSystem } from "../../src/seams/file-system.ts";

/** Directory watches a unit test drives explicitly. */
export interface FakeFileWatch {
	activeDirectories: () => Array<string>;
	change: (directory: string, filename: null | string, event?: "change" | "rename") => void;
	error: (directory: string, error: Error) => void;
	watch: FileSystem["watch"];
}

/**
 * Create watches that observe only the events the test sends.
 *
 * @returns The watch seam and its event controls.
 */
export function createFakeFileWatch(): FakeFileWatch {
	const watchers = new Map<EventEmitter, string>();
	return {
		activeDirectories: () => [...watchers.values()],
		change: (directory, filename, event = "change") => {
			for (const [watcher, watched] of watchers) {
				if (watched === path.resolve(directory)) {
					watcher.emit("change", event, filename);
				}
			}
		},
		error: (directory, error) => {
			for (const [watcher, watched] of watchers) {
				if (watched === path.resolve(directory)) {
					watcher.emit("error", error);
				}
			}
		},
		watch: fromAny(vi.fn((directory: string) => makeWatcher(watchers, directory))),
	};
}

/**
 * Register one closable directory watch.
 *
 * @param watchers - The active watches.
 * @param directory - The directory it watches.
 * @returns Its event emitter and close method.
 */
function makeWatcher(
	watchers: Map<EventEmitter, string>,
	directory: string,
): EventEmitter & { close: () => void } {
	const watcher = new EventEmitter();
	watchers.set(watcher, path.resolve(directory));
	return Object.assign(watcher, {
		close: () => {
			watchers.delete(watcher);
		},
	});
}
