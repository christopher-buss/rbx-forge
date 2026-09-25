/**
 * Holds a file lock until it is killed, so a test can check that the OS
 * releases a lock when its holder dies.
 *
 * Usage: `node lock-holder.ts <addon.node> <lock file> <exclusive|shared>`.
 * Prints `locked` once it holds the lock, or `busy` and exits 1 when another
 * holder's lock conflicts.
 */
import { createRequire } from "node:module";
import process from "node:process";

import type { LockMode, NativeAddon } from "../../../src/native/addon.ts";

const [ADDON_PATH = "", LOCK_PATH = "", MODE = "exclusive"] = process.argv.slice(2);

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the test passes the real addon
const addon = createRequire(import.meta.url)(ADDON_PATH) as NativeAddon;
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the test passes a valid mode
const lock = addon.tryLockFile(LOCK_PATH, MODE as LockMode);

if (lock === null) {
	process.stdout.write("busy\n");
	process.exitCode = 1;
} else {
	process.stdout.write("locked\n");
	// Keep the lock referenced: a collected lock is released.
	process.once("exit", () => {
		lock.release();
	});
	setInterval(() => {
		// Keep the process alive.
	}, 60_000);
}
