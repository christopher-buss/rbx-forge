import { isentinel } from "@isentinel/eslint-config/oxlint";

export default isentinel({
	name: "project/options",
	ignores: ["reaper/target", ".tmp", ".claude", "plugin"],
	jsPlugins: false,
	options: {
		typeAware: true,
	},
	roblox: false,
	test: {
		vitest: { extended: true },
	},
	type: "package",
});
