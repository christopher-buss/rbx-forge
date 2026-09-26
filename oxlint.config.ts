import { isentinel } from "@isentinel/eslint-config/oxlint";

export default isentinel({
	name: "project/options",
	ignores: ["reaper/target", ".tmp", ".claude"],
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
