/** One typed property value, encoded with an rbx_types variant tag. */
export interface CaptureProperty {
	name: string;
	value: Record<string, unknown>;
}

/** One service's roots and readable metadata in the single serialized model. */
export interface CaptureService {
	name: string;
	attributes?: Array<CaptureProperty>;
	properties?: Array<CaptureProperty>;
	roots: Array<number>;
	tags?: Array<string>;
	/** Serialized properties whose protected reads failed in this Studio. */
	unreadableProperties?: Array<string>;
}

/** One edited property that capture cannot carry into syncback. */
export interface CaptureWarning {
	property: string;
	reason: "collision_groups" | "material_override" | "unreadable";
	service: string;
}

/** One serialized copy of Studio's service children. */
export interface Capture {
	model: Uint8Array;
	services: Array<CaptureService>;
	warnings?: Array<CaptureWarning>;
}

/** A listener that accepts capture data, never session control requests. */
export interface CaptureListener {
	captureAsync: (signal: AbortSignal) => Promise<Capture>;
	close: () => void;
	url: string;
}
/** A snapshot keeps its endpoint address between open and save. */
export interface CaptureAddress {
	port: number;
	secret: string;
}
