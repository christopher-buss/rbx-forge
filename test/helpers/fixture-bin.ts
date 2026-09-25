import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/** Roles `test/fixtures/bin/fake-worker.ts` knows, each written as a shim. */
const FIXTURE_ROLES = ["hook", "rbxtsc", "rojo"] as const;

const FAKE_WORKER = path.join(import.meta.dirname, "..", "fixtures", "bin", "fake-worker.ts");

/**
 * Write one shim per fixture role into `directory`, so the directory can go
 * first on `PATH` in place of real rojo and compiler binaries. Shims run the
 * fake worker with the current Node executable. They are generated, not
 * checked in, so line endings and the executable bit never depend on git.
 *
 * @param directory - Directory to create and fill.
 * @returns The same directory.
 */
export function createFixtureBinDirectory(directory: string): string {
	mkdirSync(directory, { recursive: true });

	for (const role of FIXTURE_ROLES) {
		if (process.platform === "win32") {
			writeFileSync(
				path.join(directory, `${role}.cmd`),
				`@"${process.execPath}" "${FAKE_WORKER}" ${role} %*\r\n`,
			);
			continue;
		}

		const shim = path.join(directory, role);
		writeFileSync(
			shim,
			`#!/bin/sh\nexec "${process.execPath}" "${FAKE_WORKER}" ${role} "$@"\n`,
		);
		chmodSync(shim, 0o755);
	}

	return directory;
}
