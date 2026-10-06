import { once } from "node:events";
import type { FSWatcher } from "node:fs";
import { writeFileSync } from "node:fs";
import path from "node:path";

const PROBE_INTERVAL_MS = 20;

/**
 * Write probe files into `directory` until `watcher` reports one. FSEvents on
 * macOS starts a watch asynchronously and drops writes made before then.
 *
 * @param watcher - A watch on `directory`.
 * @param directory - The watched directory.
 * @param timeoutMs - Give up after this long.
 * @rejects When the timeout passes, the watcher closes or errors, or a probe
 *   cannot be written.
 */
export async function waitUntilWatchingAsync(
	watcher: FSWatcher,
	directory: string,
	timeoutMs = 3000,
): Promise<void> {
	const stop = new AbortController();
	const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(timeoutMs)]);
	function onClose(): void {
		stop.abort(new Error("watcher closed"));
	}

	watcher.once("close", onClose);
	let probe = 0;
	const timer = setInterval(() => {
		try {
			writeFileSync(path.join(directory, `.watch-probe-${probe}`), "");
			probe += 1;
		} catch (err) {
			stop.abort(err);
		}
	}, PROBE_INTERVAL_MS);
	try {
		await once(watcher, "change", { signal });
	} catch (err) {
		throw new Error(`watch on ${directory} saw none of ${probe} probes`, {
			cause: signal.aborted ? signal.reason : err,
		});
	} finally {
		clearInterval(timer);
		watcher.off("close", onClose);
	}
}
