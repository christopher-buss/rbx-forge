import process from "node:process";

import { ARTIFACTS, files, main, publishDependencies, STAGING } from "./effects.ts";
import { publishRelease, releaseVersion } from "./release.ts";

main(() => {
	publishRelease(publishDependencies, {
		artifacts: ARTIFACTS,
		root: ".",
		staging: STAGING,
		tag: "latest",
		version: releaseVersion(files.read("package.json"), process.env["GITHUB_REF_NAME"]),
	});
});
