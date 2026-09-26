import { describe, expect, it } from "vitest";

import { catchForgeError } from "../../test/helpers/errors.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import { createMemoryFileSystem, PROJECT } from "../../test/helpers/seams.ts";
import type { LockSeams } from "./locks.ts";
import { acquireSingleton } from "./locks.ts";
import { forgeFiles } from "./session-files.ts";

const FORGE = forgeFiles(PROJECT);

function makeSeams() {
	const memory = createMemoryFileSystem();
	const native = createFakeNative();
	const seams: Pick<LockSeams, "fileSystem" | "native"> = {
		fileSystem: memory.fileSystem,
		native: () => native.addon,
	};
	return { memory, native, seams };
}

describe(acquireSingleton, () => {
	it("should take .forge/supervisor.lock exclusively, making .forge first", () => {
		expect.assertions(2);

		const { memory, native, seams } = makeSeams();
		acquireSingleton(seams, FORGE);

		expect(native.locks.get(FORGE.lock)).toStrictEqual(["exclusive"]);
		expect(memory.files()).toStrictEqual({ ".forge": null });
	});

	it("should refuse with session_running while another supervisor holds it", () => {
		expect.assertions(2);

		const { native, seams } = makeSeams();
		native.addon.tryLockFile(FORGE.lock, "exclusive");
		const error = catchForgeError(() => acquireSingleton(seams, FORGE));

		expect(error.code).toBe("session_running");
		expect(error.message).toBe("A session already runs for this project.");
	});
});
