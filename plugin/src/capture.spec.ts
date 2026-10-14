import { describe, expect, it, jest } from "@rbxts/jest-globals";

import { CAPTURE_INSTANCE, CAPTURE_URL_ATTRIBUTE, startPlugin } from "./capture";
import type { PluginIo } from "./capture";

function createIo(): { io: PluginIo; output: jest.Mock; request: jest.Mock } {
	const [request, requestAsync] = jest.fn();
	const [output, print] = jest.fn();
	const io = {
		http: { RequestAsync: requestAsync },
		output: print,
		services: {
			history: game.GetService("ChangeHistoryService"),
			serialization: game.GetService("SerializationService"),
		},
	};
	return { io, output, request };
}

describe("startPlugin", () => {
	it("should stay inert without a capture instance", () => {
		expect.assertions(3);

		const { io, output, request } = createIo();
		const root = new Instance("Folder");

		expect(startPlugin(root, io)).toBeUndefined();
		expect(request).never.toHaveBeenCalled();
		expect(output).never.toHaveBeenCalled();
	});

	it("should stay inert when the capture instance has no URL", () => {
		expect.assertions(3);

		const { io, output, request } = createIo();
		const root = new Instance("Folder");
		const capture = new Instance("Configuration", root);
		capture.Name = CAPTURE_INSTANCE;

		expect(startPlugin(root, io)).toBeUndefined();
		expect(request).never.toHaveBeenCalled();
		expect(output).never.toHaveBeenCalled();
	});

	it("should stay inert when the capture instance is not a Configuration", () => {
		expect.assertions(1);

		const { io } = createIo();
		const root = new Instance("Folder");
		const capture = new Instance("Folder", root);
		capture.Name = CAPTURE_INSTANCE;
		capture.SetAttribute(CAPTURE_URL_ATTRIBUTE, "http://127.0.0.1:1/x");

		expect(startPlugin(root, io)).toBeUndefined();
	});

	it("should hold the capture URL without acting on it", () => {
		expect.assertions(3);

		const { io, output, request } = createIo();
		const root = new Instance("Folder");
		const capture = new Instance("Configuration", root);
		capture.Name = CAPTURE_INSTANCE;
		capture.SetAttribute(CAPTURE_URL_ATTRIBUTE, "http://127.0.0.1:1/x");

		expect(startPlugin(root, io)).toMatchObject({ url: "http://127.0.0.1:1/x" });
		expect(request).never.toHaveBeenCalled();
		expect(output).never.toHaveBeenCalled();
	});
});
