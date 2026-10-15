/* cspell:words rawget */
import { pollCaptures, startPlugin } from "./capture";
import type { PluginIo } from "./capture";

const root = game.GetService("ServerStorage");
const http = game.GetService("HttpService");
const reflection = game.GetService("ReflectionService");
const serialization = game.GetService("SerializationService");
const run = game.GetService("RunService");
const io: PluginIo = {
	http: {
		decode: (value) => http.JSONDecode(value),
		encode: (value) => http.JSONEncode(value),
		request: (request) => http.RequestAsync(request),
	},
	output: print,
	services: {
		history: game.GetService("ChangeHistoryService"),
		isRunning: () => run.IsRunning(),
		isSerialized: (name) => {
			const reflected = reflection.GetClass(name);
			return reflected !== undefined && rawget(reflected, "Serialized") === true;
		},
		serialize: (instances) => serialization.SerializeInstancesAsync(instances),
	},
};
let current: string | undefined;
for (;;) {
	task.wait(0.25);
	const active = startPlugin(root, io);
	if (active?.url !== current) {
		current = active?.url;
		if (active !== undefined) {
			task.spawn(() => {
				pollCaptures(root, active);
			});
		}
	}
}
