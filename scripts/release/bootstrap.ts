import process from "node:process";

import { ARTIFACTS, main, publishDependencies, STAGING } from "./effects.ts";
import { bootstrapRelease } from "./release.ts";

main(() => {
	const [version] = process.argv.slice(2);
	if (version === undefined) {
		throw new Error("usage: pnpm release:bootstrap <prerelease version>");
	}

	bootstrapRelease(publishDependencies, {
		artifacts: ARTIFACTS,
		root: ".",
		staging: STAGING,
		version,
	});
});
