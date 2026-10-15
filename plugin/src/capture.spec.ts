/* cspell:words fromstring readu readstring */
import { describe, expect, it, jest } from "@rbxts/jest-globals";

import {
	CAPTURE_INSTANCE,
	CAPTURE_URL_ATTRIBUTE,
	captureInstances,
	pollCaptures,
	startPlugin,
} from "./capture";
import type { PluginIo } from "./capture";

function makeCapture(root: Instance): Configuration {
	const capture = new Instance("Configuration", root);
	capture.Name = CAPTURE_INSTANCE;
	capture.SetAttribute(
		CAPTURE_URL_ATTRIBUTE,
		"http://127.0.0.1:1/capture/secret?projectName=p&sessionId=s",
	);
	capture.SetAttribute("ProjectName", "p");
	capture.SetAttribute("SessionId", "s");
	capture.SetAttribute("ConnectedProjectName", "p");
	capture.SetAttribute("ConnectedSessionId", "s");
	return capture;
}

function playPoll(
	options: {
		disconnectOnGet?: boolean;
		failure?: "network" | "serialize";
		project?: string;
		replaceUrl?: string;
		requestId?: number | string;
		running?: boolean;
		session?: string;
		status?: number;
	} = {},
): { messages: Array<string>; posts: Array<RequestAsyncRequest> } {
	const root = new Instance("Folder");
	const capture = makeCapture(root);
	const posts = new Array<RequestAsyncRequest>();
	const messages = new Array<string>();
	const http = game.GetService("HttpService");
	const io: PluginIo = {
		http: {
			decode: (value) => http.JSONDecode(value),
			encode: (value) => http.JSONEncode(value),
			request: (request) => {
				if (
					request.Method === "POST" ||
					options.status === 204 ||
					options.project !== undefined ||
					options.requestId !== undefined ||
					options.session !== undefined ||
					options.disconnectOnGet === true ||
					options.failure === "network"
				) {
					capture.SetAttribute("ConnectedSessionId", "ended");
				}

				if (options.failure === "network") {
					error("network unavailable");
				}

				if (options.replaceUrl !== undefined) {
					capture.SetAttribute(CAPTURE_URL_ATTRIBUTE, options.replaceUrl);
				}

				if (request.Method === "POST") {
					posts.push(request);
				}

				return {
					Body: http.JSONEncode({
						projectName: options.project ?? "p",
						requestId: options.requestId ?? "request",
						sessionId: options.session ?? "s",
					}),
					Headers: {},
					StatusCode: options.status ?? 200,
					StatusMessage: "OK",
					Success: true,
				};
			},
		},
		output: (message) => {
			messages.push(message);
		},
		services: {
			history: game.GetService("ChangeHistoryService"),
			isRunning: () => options.running === true,
			isSerialized: () => false,
			serialize: () => {
				if (options.failure === "serialize") {
					error("serialization unavailable");
				}

				return buffer.fromstring("\0\x80\xff");
			},
		},
	};
	const active = startPlugin(root, io);
	assert(active !== undefined);
	pollCaptures(root, active);
	return { messages, posts };
}

function createIo(): { io: PluginIo; output: jest.Mock; request: jest.Mock } {
	const [request, requestAsync] = jest.fn();
	const [output, print] = jest.fn();
	const io = {
		http: {
			decode: (value: string) => game.GetService("HttpService").JSONDecode(value),
			encode: (value: unknown) => game.GetService("HttpService").JSONEncode(value),
			request: requestAsync,
		},
		output: print,
		services: {
			history: game.GetService("ChangeHistoryService"),
			isRunning: () => false,
			isSerialized: () => true,
			serialize: (instances: Array<Instance>) => {
				return game.GetService("SerializationService").SerializeInstancesAsync(instances);
			},
		},
	};
	return { io, output, request };
}

describe("startPlugin", () => {
	it("should ignore a malformed capture request identifier", () => {
		expect.assertions(1);

		expect(playPoll({ requestId: 0 }).posts).toStrictEqual([]);
	});

	it.each([
		{ attribute: CAPTURE_URL_ATTRIBUTE, value: "https://example.com/capture" },
		{ attribute: "ProjectName", value: "" },
		{ attribute: "ProjectName", value: 1 },
		{ attribute: "SessionId", value: "" },
		{ attribute: "SessionId", value: 1 },
	])("should stay inert with invalid $attribute=$value", ({ attribute, value }) => {
		expect.assertions(1);

		const root = new Instance("Folder");
		const capture = makeCapture(root);
		capture.SetAttribute(attribute, value);

		expect(startPlugin(root, createIo().io)).toBeUndefined();
	});

	it("should discard a request after Rojo disconnected during the long poll", () => {
		expect.assertions(1);

		expect(playPoll({ disconnectOnGet: true }).posts).toStrictEqual([]);
	});

	it("should discard a request after a new session replaced the URL", () => {
		expect.assertions(1);

		expect(
			playPoll({
				replaceUrl: "http://127.0.0.1:1/capture/newsecret?projectName=p&sessionId=s",
			}).posts,
		).toStrictEqual([]);
	});

	it("should discard a capture request for another session", () => {
		expect.assertions(1);

		expect(playPoll({ session: "other" }).posts).toStrictEqual([]);
	});

	it("should stay inert without a capture instance", () => {
		expect.assertions(3);

		const { io, output, request } = createIo();
		const root = new Instance("Folder");

		expect(startPlugin(root, io)).toBeUndefined();
		expect(request).never.toHaveBeenCalled();
		expect(output).never.toHaveBeenCalled();
	});

	it("should send one raw binary frame with a metadata prefix", () => {
		expect.assertions(3);

		const { posts } = playPoll();

		expect(posts.size()).toBe(1);

		const posted = posts[0];
		assert(posted !== undefined);
		assert(typeIs(posted.Body, "string"));
		const body = buffer.fromstring(posted.Body);
		const size = buffer.readu32(body, 0);

		expect(
			game.GetService("HttpService").JSONDecode(buffer.readstring(body, 4, size)),
		).toStrictEqual({ services: [] });
		expect(buffer.readstring(body, 4 + size, 3)).toBe("\0\x80\xff");
	});

	it("should ignore a long poll with no capture request", () => {
		expect.assertions(1);

		expect(playPoll({ status: 204 }).posts).toStrictEqual([]);
	});

	it("should ignore a request for another project", () => {
		expect.assertions(1);

		expect(playPoll({ project: "other" }).posts).toStrictEqual([]);
	});

	it("should reject a capture in Play mode", () => {
		expect.assertions(1);

		const posted = playPoll({ running: true }).posts[0];
		assert(posted !== undefined);

		expect(posted.Body).toBe('{"error":"play_mode"}');
	});

	it("should report serialization failure", () => {
		expect.assertions(2);

		const { messages, posts } = playPoll({ failure: "serialize" });
		assert(posts[0] !== undefined);

		expect(posts[0].Body).toBe('{"error":"serialize_failed"}');
		expect(messages[0]).toMatch("serialization unavailable");
	});

	it("should retry failed HTTP requests without output", () => {
		expect.assertions(2);

		const { messages, posts } = playPoll({ failure: "network" });

		expect(posts).toStrictEqual([]);
		expect(messages).toStrictEqual([]);
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
		capture.SetAttribute(
			CAPTURE_URL_ATTRIBUTE,
			"http://127.0.0.1:1/capture/secret?projectName=p&sessionId=s",
		);
		capture.SetAttribute("ProjectName", "p");
		capture.SetAttribute("SessionId", "s");
		capture.SetAttribute("ConnectedProjectName", "p");
		capture.SetAttribute("ConnectedSessionId", "s");

		expect(startPlugin(root, io)).toMatchObject({
			url: "http://127.0.0.1:1/capture/secret?projectName=p&sessionId=s",
		});
		expect(request).never.toHaveBeenCalled();
		expect(output).never.toHaveBeenCalled();
	});

	it("should stay inert when the connected Rojo identity differs", () => {
		expect.assertions(1);

		const { io } = createIo();
		const root = new Instance("Folder");
		const capture = new Instance("Configuration", root);
		capture.Name = CAPTURE_INSTANCE;
		capture.SetAttribute(
			CAPTURE_URL_ATTRIBUTE,
			"http://127.0.0.1:1/capture/secret?projectName=p&sessionId=s",
		);
		capture.SetAttribute("ProjectName", "p");
		capture.SetAttribute("SessionId", "s");
		capture.SetAttribute("ConnectedProjectName", "p");
		capture.SetAttribute("ConnectedSessionId", "other");

		expect(startPlugin(root, io)).toBeUndefined();
	});

	it("should serialize every service's children in one call and skip session instances", () => {
		expect.assertions(3);

		const { io } = createIo();
		const [serialized, serialize] = jest.fn((instances: Array<Instance>) => {
			return buffer.fromstring(instances.map((instance) => instance.Name).join(","));
		});
		const root = new Instance("Folder");
		const first = new Instance("Folder", root);
		const second = new Instance("Folder", root);
		const capture = new Instance("Configuration", first);
		const part = new Instance("Part", first);
		part.Name = "EditedPart";
		const camera = new Instance("Camera", first);
		camera.Name = "SessionCamera";
		const omitted = new Instance("Part", first);
		omitted.Archivable = false;
		const module = new Instance("ModuleScript", second);
		module.Name = "EditedScript";
		const payload = captureInstances(root, {
			capture,
			io: {
				...io,
				services: {
					...io.services,
					isSerialized: () => true,
					serialize,
				},
			},
			url: "",
		});

		expect(buffer.tostring(payload.model)).toBe("EditedPart,EditedScript");
		expect(game.GetService("HttpService").JSONEncode(payload.services)).toBe(
			'[{"name":"Folder","roots":[0]},{"name":"Folder","roots":[1]}]',
		);
		expect(serialized.mock.calls.size()).toBe(1);
	});
});
