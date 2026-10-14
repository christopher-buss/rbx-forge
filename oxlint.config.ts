import { GLOB_SRC, GLOB_TESTS } from "@isentinel/eslint-config";
import { isentinel } from "@isentinel/eslint-config/oxlint";

const PLUGIN_SRC = `plugin/src/${GLOB_SRC}`;
const PLUGIN_TESTS = GLOB_TESTS.map((glob) => `plugin/src/${glob}`);
const NODE_TESTS = ["src", "scripts", "test"].flatMap((directory) => {
	return GLOB_TESTS.map((glob) => `${directory}/${glob}`);
});

export default isentinel({
	name: "project/options",
	ignores: ["reaper/target", ".tmp", ".claude", "plugin/{build,include,out,.jest-roblox}"],
	jsPlugins: false,
	options: {
		typeAware: true,
	},
	roblox: { files: [PLUGIN_SRC], filesTypeAware: [PLUGIN_SRC] },
	test: {
		jest: { extended: true, files: PLUGIN_TESTS },
		vitest: { extended: true, files: NODE_TESTS },
	},
	type: "package",
});
