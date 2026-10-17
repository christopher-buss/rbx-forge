/** One service's roots in the single serialized model, in input order. */
export interface CaptureService {
	name: string;
	roots: Array<number>;
}

/** One serialized copy of Studio's service children. */
export interface Capture {
	model: Uint8Array;
	services: Array<CaptureService>;
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
