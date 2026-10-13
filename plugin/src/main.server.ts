import { startPlugin } from "./capture";

startPlugin(game.GetService("ServerStorage"), {
	http: game.GetService("HttpService"),
	output: print,
	services: {
		history: game.GetService("ChangeHistoryService"),
		serialization: game.GetService("SerializationService"),
	},
});
