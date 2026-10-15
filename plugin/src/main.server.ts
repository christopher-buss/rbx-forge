/* cspell:words rawget */
import { pollCaptures, startPlugin } from "./capture";
import type { PluginIo } from "./capture";
import type { ReflectedProperty } from "./service-metadata";

const root = game.GetService("ServerStorage");
const http = game.GetService("HttpService");
const reflection = game.GetService("ReflectionService");
const serialization = game.GetService("SerializationService");
const run = game.GetService("RunService");
const capabilities = Enum.SecurityCapability.GetEnumItems();
const allCapabilities = new SecurityCapabilities(...capabilities);
const io: PluginIo = {
	http: {
		decode: (value) => http.JSONDecode(value),
		encode: (value) => http.JSONEncode(value),
		request: (request) => http.RequestAsync(request),
	},
	output: print,
	services: {
		capabilityBits: (value) => {
			return capabilities.filter((item) => value.Contains(item)).map((item) => item.Value);
		},
		history: game.GetService("ChangeHistoryService"),
		isRunning: () => run.IsRunning(),
		isSerialized: (name) => {
			const reflected = reflection.GetClass(name);
			return reflected !== undefined && rawget(reflected, "Serialized") === true;
		},
		properties: (name) => {
			const properties = new Array<ReflectedProperty>();
			const reflectedProperties = reflection.GetPropertiesOfClass(name, {
				ExcludeDisplay: true,
				Security: allCapabilities,
			});
			for (const property of reflectedProperties) {
				const reflectedType = rawget(property, "Type");
				properties.push({
					name: tostring(rawget(property, "Name")),
					engineType: tostring(rawget(reflectedType, "EngineType")),
					serialized: rawget(property, "Serialized") === true,
				});
			}

			return properties;
		},
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- runtime reflection supplies property names
		readProperty: (service, name) => (service as unknown as Record<string, unknown>)[name],
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
