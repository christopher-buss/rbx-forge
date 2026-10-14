/** The instance a forge session or snapshot fills with its capture URL. */
export const CAPTURE_INSTANCE = "ForgeCapture";
/** The attribute of {@link CAPTURE_INSTANCE} that holds the URL. */
export const CAPTURE_URL_ATTRIBUTE = "CaptureUrl";

/** What the plugin reaches outside itself. Specs pass fakes. */
export interface PluginIo {
	http: Pick<HttpService, "RequestAsync">;
	output: (message: string) => void;
	/** The engine services a capture uses. */
	services: { history: ChangeHistoryService; serialization: SerializationService };
}

/** A plugin that holds a forge capture URL. */
export interface ActivePlugin {
	io: PluginIo;
	url: string;
}

/**
 * Start the plugin. Without a capture URL it returns at once: no request, no
 * output, no UI.
 *
 * @param root - Where forge puts the capture instance.
 * @param io - HTTP, output, and engine services.
 * @returns The active plugin; `undefined` when inert.
 */
export function startPlugin(root: Instance, io: PluginIo): ActivePlugin | undefined {
	const url = findCaptureUrl(root);
	return url === undefined ? undefined : { io, url };
}

/**
 * Find the forge capture URL.
 *
 * @param root - Where forge puts the capture instance.
 * @returns The URL; `undefined` in a Studio forge does not serve.
 */
function findCaptureUrl(root: Instance): string | undefined {
	const capture = root.FindFirstChild(CAPTURE_INSTANCE);
	if (capture === undefined || !capture.IsA("Configuration")) {
		return undefined;
	}

	const url = capture.GetAttribute(CAPTURE_URL_ATTRIBUTE);
	return url !== "" && typeIs(url, "string") ? url : undefined;
}
