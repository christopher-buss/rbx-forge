/* cspell:words fromstring readu readstring rbxassetid keypoints pcall */
/* cspell:words rawget */
import { describe, expect, it, jest } from "@rbxts/jest-globals";

import {
	CAPTURE_INSTANCE,
	CAPTURE_URL_ATTRIBUTE,
	captureInstances,
	pollCaptures,
	startPlugin,
} from "./capture";
import type { PluginIo } from "./capture";
import type { CaptureWarnings } from "./capture-warnings";
import type { ReflectedProperty } from "./service-metadata";

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
		warnings?: CaptureWarnings;
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
			capabilityBits: () => [],
			history: game.GetService("ChangeHistoryService"),
			isRunning: () => options.running === true,
			isSerialized: () => false,
			properties: () => [],
			readProperty: () => error("unexpected property read"),
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
	pollCaptures(
		root,
		options.warnings === undefined ? active : { ...active, warnings: options.warnings },
	);
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
			capabilityBits: () => new Array<number>(),
			history: game.GetService("ChangeHistoryService"),
			isRunning: () => false,
			isSerialized: () => true,
			properties: () => new Array<ReflectedProperty>(),
			readProperty: () => error("unexpected property read"),
			serialize: (instances: Array<Instance>) => {
				return game.GetService("SerializationService").SerializeInstancesAsync(instances);
			},
		},
	};
	return { io, output, request };
}

function referenceTree(nested: boolean): {
	capture: Configuration;
	root: Folder;
	service: Folder;
	source: Instance;
	target: Part;
} {
	const root = new Instance("Folder");
	const service = new Instance("Folder", root);
	const parent = nested ? new Instance("Folder", service) : service;
	const target = new Instance("Part", parent);
	return {
		capture: new Instance("Configuration", service),
		root,
		service,
		source: nested ? parent : target,
		target,
	};
}

describe("startPlugin", () => {
	it("should retain pending warnings when serialization fails before a successful capture", () => {
		expect.assertions(2);

		const { io } = createIo();
		const root = new Instance("Folder");
		const capture = new Instance("Configuration");
		let canSerialize = false;
		let pending = [
			{
				property: "PhysicsSteppingMethod",
				reason: "unreadable" as const,
				service: "Workspace",
			},
		];
		const active = {
			capture,
			io: {
				...io,
				services: {
					...io.services,
					serialize: () => {
						assert(canSerialize, "serialization unavailable");
						return buffer.create(0);
					},
				},
			},
			url: "",
			warnings: {
				capture: () => {
					const warnings = pending;
					pending = [];
					return warnings;
				},
				close: () => {},
				resume: () => {},
			},
		};

		expect(() => captureInstances(root, active)).toThrow("serialization unavailable");

		canSerialize = true;
		const saved = captureInstances(root, active);

		expect(saved.warnings.map((warning) => warning.property).join(",")).toBe(
			"PhysicsSteppingMethod",
		);
	});

	it.each([
		{ engineType: "bool", expected: { Bool: false }, value: false },
		{ engineType: "double", expected: { Float64: 1.25 }, value: 1.25 },
		{ engineType: "int", expected: { Int32: -3 }, value: -3 },
		{ engineType: "int64", expected: { Int64: 9007199254740991 }, value: 9007199254740991 },
		{
			engineType: "ContentId",
			expected: { ContentId: "rbxassetid://123" },
			value: "rbxassetid://123",
		},
		{ engineType: "Enum", expected: { Enum: 3 }, value: Enum.Technology.ShadowMap },
		{ engineType: "Vector3", expected: { Vector3: [1, -2, 3] }, value: new Vector3(1, -2, 3) },
		{
			engineType: "Color3",
			expected: { Color3: [0.25, 0.5, 1] },
			value: new Color3(0.25, 0.5, 1),
		},
		{ engineType: "Vector2", expected: { Vector2: [4, -5] }, value: new Vector2(4, -5) },
		{ engineType: "UDim", expected: { UDim: [0.5, 12] }, value: new UDim(0.5, 12) },
		{
			engineType: "UDim2",
			expected: {
				UDim2: [
					[0.5, 12],
					[0.25, -6],
				],
			},
			value: new UDim2(0.5, 12, 0.25, -6),
		},
		{
			engineType: "BrickColor",
			expected: { BrickColor: 21 },
			value: new BrickColor("Bright red"),
		},
		{
			engineType: "NumberRange",
			expected: { NumberRange: [1, 8] },
			value: new NumberRange(1, 8),
		},
		{
			engineType: "Rect",
			expected: {
				Rect: [
					[1, 2],
					[3, 4],
				],
			},
			value: new Rect(1, 2, 3, 4),
		},
		{
			engineType: "CFrame",
			expected: {
				CFrame: {
					orientation: [
						[1, 0, 0],
						[0, 1, 0],
						[0, 0, 1],
					],
					position: [1, 2, 3],
				},
			},
			value: new CFrame(1, 2, 3),
		},
		{
			engineType: "NumberSequence",
			expected: {
				NumberSequence: {
					keypoints: [
						{ envelope: 0, time: 0, value: 0.5 },
						{ envelope: 0, time: 1, value: 0.5 },
					],
				},
			},
			value: new NumberSequence(0.5),
		},
		{
			engineType: "ColorSequence",
			expected: {
				ColorSequence: {
					keypoints: [
						{ color: [0.25, 0.5, 1], time: 0 },
						{ color: [0.25, 0.5, 1], time: 1 },
					],
				},
			},
			value: new ColorSequence(new Color3(0.25, 0.5, 1)),
		},
		{
			engineType: "Font",
			expected: { Font: { family: "rbxassetid://123", style: "Italic", weight: "Bold" } },
			value: new Font("rbxassetid://123", Enum.FontWeight.Bold, Enum.FontStyle.Italic),
		},
		{
			engineType: "SecurityCapabilities",
			expected: { CapabilityBits: [0, 63] },
			value: new SecurityCapabilities(),
		},
		{
			engineType: "RefType",
			expected: { Ref: "00000000000000000000000000000000" },
			value: undefined,
		},
	])(
		"should preserve a readable $engineType property's typed value",
		({ engineType, expected, value }) => {
			expect.assertions(1);

			const { io } = createIo();
			const root = new Instance("Folder");
			const service = new Instance("Folder", root);
			const capture = new Instance("Configuration", service);
			const payload = captureInstances(root, {
				capture,
				io: {
					...io,
					services: {
						...io.services,
						capabilityBits: () => [0, 63],
						properties: () => [{ name: "Edited", engineType, serialized: true }],
						readProperty: () => value,
						serialize: () => buffer.create(0),
					},
				},
				url: "",
			});
			const metadata = payload.services[0];
			assert(metadata !== undefined);
			const property = metadata.properties[0];
			assert(property !== undefined);

			// eslint-disable-next-line jest/prefer-strict-equal -- strict equality rejects nested engine strings
			expect(property.value).toEqual(expected);
		},
	);

	it.each([{ nested: false }, { nested: true }])(
		"should keep a readable instance reference in the one model (nested=$nested) and destroy its temporary carrier",
		({ nested }) => {
			expect.assertions(1);

			const { io } = createIo();
			const { capture, root, source, target } = referenceTree(nested);
			const serialized = new Array<Instance>();
			const payload = captureInstances(root, {
				capture,
				io: {
					...io,
					services: {
						...io.services,
						properties: () => [
							{ name: "PrimaryPart", engineType: "RefType", serialized: true },
						],
						readProperty: () => target,
						serialize: (instances) => {
							for (const instance of instances) {
								serialized.push(instance);
							}

							const carrier = instances[1];
							assert(carrier !== undefined);
							assert(carrier.IsA("ObjectValue"));
							assert(carrier.Value === target);
							return io.services.serialize(instances);
						},
					},
				},
				url: "",
			});
			const metadata = payload.services[0];
			assert(metadata !== undefined);
			const property = metadata.properties[0];
			const carrier = serialized[1];
			assert(property !== undefined);
			assert(carrier !== undefined);
			assert(carrier.IsA("ObjectValue"));

			const [canMove] = pcall(() => {
				carrier.Parent = root;
			});

			expect([
				metadata.roots[0],
				serialized.size(),
				serialized[0] === source,
				property.value["InstanceRef"],
				canMove,
				buffer.len(payload.model) > 0,
			]).toStrictEqual([0, 2, true, 1, false, true]);
		},
	);

	it.each([
		{ expected: { ServiceRef: "Folder" }, target: "service" },
		{ expected: { Ref: "00000000000000000000000000000000" }, target: "excluded" },
	])(
		"should preserve a reference to a $target instance without an extra serialized root",
		({ expected, target }) => {
			expect.assertions(1);

			const { io } = createIo();
			const root = new Instance("Folder");
			const service = new Instance("Folder", root);
			const capture = new Instance("Configuration", service);
			const excluded = new Instance("Part", service);
			excluded.Archivable = false;
			const persisted = new Instance("Part", service);
			const targets: Record<string, Instance> = { excluded, service };
			const payload = captureInstances(root, {
				capture,
				io: {
					...io,
					services: {
						...io.services,
						properties: () => [
							{ name: "Target", engineType: "RefType", serialized: true },
						],
						readProperty: () => targets[target],
						serialize: (instances) => {
							assert(instances.size() === 1);
							assert(instances[0] === persisted);
							return buffer.create(0);
						},
					},
				},
				url: "",
			});
			const metadata = payload.services[0];
			assert(metadata !== undefined);
			const property = metadata.properties[0];
			assert(property !== undefined);

			// eslint-disable-next-line jest/prefer-strict-equal -- strict equality rejects nested engine strings
			expect(property.value).toEqual(expected);
		},
	);

	it("should identify an unsupported readable property instead of treating it as unreadable", () => {
		expect.assertions(1);

		const { io } = createIo();
		const root = new Instance("Folder");
		const service = new Instance("Folder", root);
		const capture = new Instance("Configuration", service);

		expect(() => {
			return captureInstances(root, {
				capture,
				io: {
					...io,
					services: {
						...io.services,
						properties: () => [
							{ name: "Unsupported", engineType: "FutureType", serialized: true },
						],
						readProperty: () => ({}),
					},
				},
				url: "",
			});
		}).toThrow("Folder.Unsupported");
	});

	it("should name a current-engine reference attribute that the native writer cannot preserve", () => {
		expect.assertions(1);

		const { io } = createIo();
		const root = new Instance("Folder");
		const service = new Instance("Folder", root);
		const capture = new Instance("Configuration", service);
		const target = new Instance("Part", service);
		service.SetAttribute("Reference", target);

		expect(() => captureInstances(root, { capture, io, url: "" })).toThrow(
			"Folder attribute Reference",
		);
	});

	it("should preserve the double precision of a numeric service attribute", () => {
		expect.assertions(1);

		const { io } = createIo();
		const root = new Instance("Folder");
		const service = new Instance("Folder", root);
		const capture = new Instance("Configuration", service);
		service.SetAttribute("Number", 1.0000000000000002);
		const payload = captureInstances(root, {
			capture,
			io: { ...io, services: { ...io.services, serialize: () => buffer.create(0) } },
			url: "",
		});
		const metadata = payload.services[0];
		assert(metadata !== undefined);
		const attribute = metadata.attributes[0];
		assert(attribute !== undefined);

		expect(attribute.value).toStrictEqual({ Float64: 1.0000000000000002 });
	});

	it("should carry readable serialized properties and service attributes and tags", () => {
		expect.assertions(1);

		const { io } = createIo();
		const root = new Instance("Folder");
		const service = new Instance("Folder", root);
		service.SetAttribute("Edited", "from Studio");
		service.AddTag("capture-tag");
		const capture = new Instance("Configuration", service);
		const payload = captureInstances(root, {
			capture,
			io: {
				...io,
				services: {
					...io.services,
					properties: () => [
						{ name: "Brightness", engineType: "float", serialized: true },
						{ name: "Technology", engineType: "Enum", serialized: true },
						{ name: "Transient", engineType: "float", serialized: false },
					],
					readProperty: (_service, name) => {
						assert(name === "Brightness", `cannot read ${name}`);
						return 3.5;
					},
					serialize: () => buffer.create(0),
				},
			},
			url: "",
		});

		const metadata = payload.services[0];
		assert(metadata !== undefined);
		const property = metadata.properties[0];
		const attribute = metadata.attributes[0];
		assert(property !== undefined);
		assert(attribute !== undefined);

		expect(
			[
				payload.services.size(),
				metadata.name,
				metadata.roots.size(),
				metadata.properties.size(),
				property.name,
				tostring(property.value["Float32"]),
				metadata.attributes.size(),
				attribute.name,
				tostring(attribute.value["String"]),
				metadata.tags.size(),
				tostring(metadata.tags[0]),
				metadata.unreadableProperties.size(),
				tostring(metadata.unreadableProperties[0]),
			]
				.map(tostring)
				.join("|"),
		).toBe("1|Folder|0|1|Brightness|3.5|1|Edited|from Studio|1|capture-tag|1|Technology");
	});

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

		const { posts } = playPoll({
			warnings: {
				capture: () => [
					{
						property: "PhysicsSteppingMethod",
						reason: "unreadable",
						service: "Workspace",
					},
				],
				close: () => {},
				resume: () => {},
			},
		});

		expect(posts.size()).toBe(1);

		const posted = posts[0];
		assert(posted !== undefined);
		assert(typeIs(posted.Body, "string"));
		const body = buffer.fromstring(posted.Body);
		const size = buffer.readu32(body, 0);

		// eslint-disable-next-line jest/prefer-strict-equal -- strict equality rejects nested engine strings
		expect(game.GetService("HttpService").JSONDecode(buffer.readstring(body, 4, size))).toEqual(
			{
				services: [],
				warnings: [
					{
						property: "PhysicsSteppingMethod",
						reason: "unreadable",
						service: "Workspace",
					},
				],
			},
		);
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
		expect.assertions(3);

		const { messages, posts } = playPoll({ failure: "serialize" });
		assert(posts[0] !== undefined);
		const body = posts[0].Body;
		assert(typeIs(body, "string"));
		const rejection = game.GetService("HttpService").JSONDecode(body);

		expect(rawget(rejection, "error")).toBe("serialize_failed");
		expect(rawget(rejection, "message")).toMatch("serialization unavailable");
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
		camera.Name = "StoredCamera";
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

		expect(buffer.tostring(payload.model)).toBe("EditedPart,StoredCamera,EditedScript");
		expect(payload.services).toMatchObject([
			{ name: "Folder", roots: [0, 1] },
			{ name: "Folder", roots: [2] },
		]);
		expect(serialized.mock.calls.size()).toBe(1);
	});

	it("should exclude only Workspace's current camera from authored cameras", () => {
		expect.assertions(2);

		const { io } = createIo();
		const workspace = game.GetService("Workspace");
		const current = workspace.CurrentCamera;
		assert(current !== undefined);
		const stored = new Instance("Camera", workspace);
		const capture = new Instance("Configuration");
		let serialized = new Array<Instance>();
		captureInstances(game, {
			capture,
			io: {
				...io,
				services: {
					...io.services,
					isSerialized: (name) => name === "Workspace",
					serialize: (instances) => {
						serialized = instances;
						return buffer.create(0);
					},
				},
			},
			url: "",
		});
		stored.Destroy();
		capture.Destroy();

		expect(serialized).toContain(stored);
		expect(serialized).never.toContain(current);
	});
});
