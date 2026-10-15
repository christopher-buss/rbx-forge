import { onTestFinished } from "vitest";

import type { Fixture } from "../e2e/session-fixture.ts";
import { makeFixtureAsync } from "../e2e/session-fixture.ts";
import type { IsolatedRealStudioCli } from "./isolated-real-studio-cli.ts";
import { isolatedRealStudioCli } from "./isolated-real-studio-cli.ts";
import { loadRealNative } from "./real-native.ts";

/** An e2e project with its own built CLI and gated Studio plugins. */
export interface IsolatedStudioFixture extends Fixture {
	cli: IsolatedRealStudioCli;
}

/**
 * Register plugin cleanup before the test registers its owned Studio cleanup.
 * @param options - Project configuration and the real Plugins folder.
 * @returns The project and its private built CLI.
 */
export async function isolatedRealStudioFixtureAsync({
	config,
	pluginsDirectory,
	sharedCli,
}: {
	config: Record<string, unknown>;
	pluginsDirectory: string;
	sharedCli?: IsolatedRealStudioCli;
}): Promise<IsolatedStudioFixture> {
	const fixture = await makeFixtureAsync(config);
	const cli =
		sharedCli ??
		isolatedRealStudioCli({
			directory: fixture.project,
			native: loadRealNative(),
			pluginsDirectory,
		});
	if (sharedCli === undefined) {
		onTestFinished(cli.close);
	}

	return { ...fixture, bin: cli.bin, cli };
}
