/* cspell:words pcall rawget fromstring writeu */
import { captureServiceMetadata } from "./service-metadata";
import type { CaptureValue, ServiceMetadata, ServiceMetadataIo } from "./service-metadata";

/** The instance a forge session or snapshot fills with its capture URL. */
export const CAPTURE_INSTANCE = "ForgeCapture";
/** The attribute of {@link CAPTURE_INSTANCE} that holds the URL. */
export const CAPTURE_URL_ATTRIBUTE = "CaptureUrl";

/** Engine adapters; specs provide functions at the same boundary. */
export interface PluginIo {
	http: {
		decode: (value: string) => unknown;
		encode: (value: unknown) => string;
		request: (request: RequestAsyncRequest) => RequestAsyncResponse;
	};
	output: (message: string) => void;
	services: ServiceMetadataIo & {
		history: ChangeHistoryService;
		isRunning: () => boolean;
		isSerialized: (name: string) => boolean;
		serialize: (instances: Array<Instance>) => buffer;
	};
}

/** A plugin holding a capture URL verified by the connected Rojo plugin. */
export interface ActivePlugin {
	capture: Configuration;
	io: PluginIo;
	url: string;
}

/** The one model and its service root indices. */
export interface CapturePayload {
	model: buffer;
	services: Array<ServiceMetadata & { name: string; roots: Array<number> }>;
}

interface ServiceRoots {
	roots: Array<number>;
	service: Instance;
}

/**
 * Hold a URL only while the connected Rojo identity matches its configuration.
 * @param root - The session's ServerStorage.
 * @param io - Engine adapters.
 * @returns The verified plugin, or undefined while disconnected.
 */
export function startPlugin(root: Instance, io: PluginIo): ActivePlugin | undefined {
	const capture = root.FindFirstChild(CAPTURE_INSTANCE);
	if (capture === undefined || !capture.IsA("Configuration")) {
		return undefined;
	}

	const url = capture.GetAttribute(CAPTURE_URL_ATTRIBUTE);
	if (!typeIs(url, "string")) {
		return undefined;
	}

	if (string.match(url, "^http://127%.0%.0%.1:%d+/capture/%w+%?")[0] === undefined) {
		return undefined;
	}

	const project = capture.GetAttribute("ProjectName");
	if (project === "" || !typeIs(project, "string")) {
		return undefined;
	}

	const session = capture.GetAttribute("SessionId");
	if (session === "" || !typeIs(session, "string")) {
		return undefined;
	}

	if (
		capture.GetAttribute("ConnectedProjectName") !== project ||
		capture.GetAttribute("ConnectedSessionId") !== session
	) {
		return undefined;
	}

	return { capture, io, url };
}

/**
 * Serialize every persisted service's children together so references survive.
 * @param root - The data model.
 * @param active - The plugin and its capture configuration.
 * @returns One model and the roots belonging to each service.
 */
export function captureInstances(root: Instance, active: ActivePlugin): CapturePayload {
	const { captured, instances } = captureRoots(root, active);
	const { carriers, reference } = captureReferences(instances, captured);
	const [isCaptured, result] = pcall(() => {
		const services = new Array<ServiceMetadata & { name: string; roots: Array<number> }>();
		for (const { roots, service } of captured) {
			services.push({
				...captureServiceMetadata(service, active.io.services, reference),
				name: service.ClassName,
				roots,
			});
		}

		return { model: active.io.services.serialize(instances), services };
	});
	for (const carrier of carriers) {
		carrier.Destroy();
	}

	if (!isCaptured) {
		error(result);
	}

	return result;
}

/**
 * Poll in its own task until Rojo replaces or disconnects the URL.
 * @param root - The session's ServerStorage.
 * @param active - The current plugin generation.
 */
export function pollCaptures(root: Instance, active: ActivePlugin): void {
	while (startPlugin(root, active.io)?.url === active.url) {
		const [isSuccessful] = pcall(() => {
			receiveCapture(root, active);
		});
		if (!isSuccessful) {
			task.wait(1);
		}
	}
}

function captureChildren(service: Instance, capture: Instance): Array<Instance> {
	const currentCamera = service.IsA("Workspace") ? service.CurrentCamera : undefined;
	return service.GetChildren().filter((child) => {
		return (
			child !== capture && child !== currentCamera && child.Archivable && !child.IsA("Player")
		);
	});
}

function captureRoots(
	root: Instance,
	active: ActivePlugin,
): { captured: Array<ServiceRoots>; instances: Array<Instance> } {
	const instances = new Array<Instance>();
	const captured = new Array<ServiceRoots>();
	for (const service of root.GetChildren()) {
		if (!active.io.services.isSerialized(service.ClassName)) {
			continue;
		}

		const roots = new Array<number>();
		for (const child of captureChildren(service, active.capture)) {
			roots.push(instances.size());
			instances.push(child);
		}

		captured.push({ roots, service });
	}

	return { captured, instances };
}

function captureReferences(
	instances: Array<Instance>,
	captured: Array<ServiceRoots>,
): { carriers: Array<ObjectValue>; reference: (target: Instance) => CaptureValue } {
	const roots = [...instances];
	const carriers = new Array<ObjectValue>();
	function reference(target: Instance): CaptureValue {
		const service = captured.find((entry) => entry.service === target);
		if (service !== undefined) {
			return { ServiceRef: service.service.ClassName };
		}

		if (roots.every((child) => child !== target && !target.IsDescendantOf(child))) {
			return { Ref: "00000000000000000000000000000000" };
		}

		const carrier = new Instance("ObjectValue");
		carrier.Value = target;
		const index = instances.size();
		instances.push(carrier);
		carriers.push(carrier);
		return { InstanceRef: index };
	}

	return { carriers, reference };
}

function postError(active: ActivePlugin, url: string, reason: string): void {
	active.io.http.request({
		Body: active.io.http.encode({ error: reason }),
		Headers: { "Content-Type": "application/json" },
		Method: "POST",
		Url: url,
	});
}

function frameCapture(io: PluginIo, payload: CapturePayload): string {
	const header = buffer.fromstring(io.http.encode({ services: payload.services }));
	const size = buffer.len(header);
	const body = buffer.create(4 + size + buffer.len(payload.model));
	buffer.writeu32(body, 0, size);
	buffer.copy(body, 4, header);
	buffer.copy(body, 4 + size, payload.model);
	return buffer.tostring(body);
}

function serializeCapture(active: ActivePlugin, postUrl: string): void {
	const [isCaptured, payload] = pcall(() => captureInstances(game, active));
	if (!isCaptured) {
		active.io.output(`Forge capture failed: ${tostring(payload)}`);
		postError(active, postUrl, "serialize_failed");
		return;
	}

	active.io.http.request({
		Body: frameCapture(active.io, payload),
		Headers: { "Content-Type": "application/octet-stream" },
		Method: "POST",
		Url: postUrl,
	});
}

function receiveCapture(root: Instance, active: ActivePlugin): void {
	const response = active.io.http.request({ Method: "GET", Url: active.url });
	if (response.StatusCode !== 200) {
		return;
	}

	const request = active.io.http.decode(response.Body);
	if (
		rawget(request, "projectName") !== active.capture.GetAttribute("ProjectName") ||
		rawget(request, "sessionId") !== active.capture.GetAttribute("SessionId")
	) {
		return;
	}

	const requestId = rawget(request, "requestId");
	if (!typeIs(requestId, "string")) {
		return;
	}

	if (startPlugin(root, active.io)?.url !== active.url) {
		return;
	}

	const postUrl = `${active.url}&requestId=${requestId}`;
	if (active.io.services.isRunning()) {
		postError(active, postUrl, "play_mode");
		return;
	}

	task.spawn(() => {
		serializeCapture(active, postUrl);
	});
}
