import process from "node:process";

import { main, publishDependencies } from "./effects.ts";
import { runReleaseCheck } from "./release.ts";

main(() => {
	runReleaseCheck({ ...publishDependencies, platform: process.platform });
});
