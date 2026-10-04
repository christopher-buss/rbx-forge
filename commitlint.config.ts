import { RuleConfigSeverity } from "@commitlint/types";
import type { UserConfig } from "@commitlint/types";

/**
 * Checks pull request titles, which become the squash commits that
 * changelogithub reads.
 */
export default {
	extends: ["@commitlint/config-conventional"],
	rules: {
		"header-max-length": [RuleConfigSeverity.Error, "always", 72],
	},
} satisfies UserConfig;
