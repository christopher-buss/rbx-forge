import type { AddonStudioHostBackend, StudioHost } from "../../src/seams/studio-host.ts";
import { createAddonStudioHost } from "../../src/seams/studio-host.ts";
import { createFakeNative } from "./native.ts";
import type { FakeNative, FakeProcess } from "./native.ts";

/** A Studio host over the existing in-memory process and lock tables. */
export interface FakeStudioHost extends FakeNative {
	studioHost: StudioHost;
}

/**
 * Build a fake Studio host without reaching the real addon.
 * @param backend - Fake discovery, launch, file system, and host dependencies.
 * @param processes - Initial Studio process identities.
 * @returns The async host and its configurable process and lock tables.
 */
export function createFakeStudioHost(
	backend: Pick<
		AddonStudioHostBackend,
		"fileSystem" | "host" | "installedStudio" | "studioLauncher"
	>,
	processes: Record<number, FakeProcess> = {},
): FakeStudioHost {
	const fake = createFakeNative(processes);
	return { ...fake, studioHost: createAddonStudioHost({ ...backend, native: () => fake.addon }) };
}
