/* cspell:words pcall keypoints */
/** Runtime engine reflection, including properties the plugin cannot read. */
export interface ReflectedProperty {
	name: string;
	engineType: string;
	serialized: boolean;
}

/** Protected engine reads and the reflection descriptors that select them. */
export interface ServiceMetadataIo {
	capabilityBits: (value: SecurityCapabilities) => Array<number>;
	properties: (name: string) => Array<ReflectedProperty>;
	readProperty: (service: Instance, name: string) => unknown;
}

/** A nonempty variant-tagged value that JSONEncode can preserve. */
export type CaptureValue = Record<string, unknown>;

/** One named property or attribute and its typed value. */
export interface CaptureProperty {
	name: string;
	value: CaptureValue;
}

/** Runtime-readable service metadata beside the serialized children. */
export interface ServiceMetadata {
	attributes: Array<CaptureProperty>;
	properties: Array<CaptureProperty>;
	tags: Array<string>;
	unreadableProperties: Array<string>;
}

interface ValueContext {
	io: ServiceMetadataIo;
	reference: (value: Instance) => CaptureValue;
}

/**
 * Read serialized properties at runtime and retain failed property names.
 * @param service - The service whose children are being captured.
 * @param io - The reflection and protected read adapters.
 * @param reference - Encodes references into the one serialized model.
 * @returns Typed readable properties, attributes, tags, and failed read names.
 */
export function captureServiceMetadata(
	service: Instance,
	io: ServiceMetadataIo,
	reference: (value: Instance) => CaptureValue,
): ServiceMetadata {
	const context = { io, reference };
	return {
		...readProperties(service, context),
		attributes: readAttributes(service, context),
		tags: service.GetTags(),
	};
}

function readProperties(
	service: Instance,
	context: ValueContext,
): Pick<ServiceMetadata, "properties" | "unreadableProperties"> {
	const properties = new Array<CaptureProperty>();
	const unreadableProperties = new Array<string>();
	for (const property of context.io.properties(service.ClassName)) {
		if (!property.serialized) {
			continue;
		}

		const [canRead, value] = pcall(() => context.io.readProperty(service, property.name));
		if (!canRead) {
			unreadableProperties.push(property.name);
			continue;
		}

		properties.push({
			name: property.name,
			value: encodeValue(
				value,
				property.engineType,
				context,
				`${service.ClassName}.${property.name}`,
			),
		});
	}

	return { properties, unreadableProperties };
}

function readAttributes(service: Instance, context: ValueContext): Array<CaptureProperty> {
	const attributes = new Array<CaptureProperty>();
	// oxlint-disable-next-line unicorn/no-array-for-each -- Roblox attribute maps use the Map macro
	service.GetAttributes().forEach((value, name) => {
		attributes.push({
			name,
			value: encodeValue(
				value,
				"attribute",
				context,
				`${service.ClassName} attribute ${name}`,
			),
		});
	});
	return attributes;
}

const NUMBER_TYPES: Record<string, string> = {
	double: "Float64",
	float: "Float32",
	int: "Int32",
	int64: "Int64",
};

function encodeScalar(value: unknown, engineType: string): CaptureValue | undefined {
	if (typeIs(value, "boolean")) {
		return { Bool: value };
	}

	if (typeIs(value, "number")) {
		return { [NUMBER_TYPES[engineType] ?? "Float64"]: value };
	}

	if (typeIs(value, "string")) {
		return engineType === "ContentId" ? { ContentId: value } : { String: value };
	}

	if (value === undefined) {
		return { Ref: "00000000000000000000000000000000" };
	}

	if (typeIs(value, "EnumItem")) {
		return { Enum: value.Value };
	}

	return undefined;
}

function encodeVectors(value: unknown): CaptureValue | undefined {
	if (typeIs(value, "Vector3")) {
		return { Vector3: [value.X, value.Y, value.Z] };
	}

	if (typeIs(value, "Vector2")) {
		return { Vector2: [value.X, value.Y] };
	}

	if (typeIs(value, "Color3")) {
		return { Color3: [value.R, value.G, value.B] };
	}

	if (typeIs(value, "BrickColor")) {
		return { BrickColor: value.Number };
	}

	return undefined;
}

function encodeDimensions(value: unknown): CaptureValue | undefined {
	if (typeIs(value, "UDim")) {
		return { UDim: [value.Scale, value.Offset] };
	}

	if (typeIs(value, "UDim2")) {
		return {
			UDim2: [
				[value.X.Scale, value.X.Offset],
				[value.Y.Scale, value.Y.Offset],
			],
		};
	}

	if (typeIs(value, "NumberRange")) {
		return { NumberRange: [value.Min, value.Max] };
	}

	if (typeIs(value, "Rect")) {
		return {
			Rect: [
				[value.Min.X, value.Min.Y],
				[value.Max.X, value.Max.Y],
			],
		};
	}

	return undefined;
}

function encodeSequences(value: unknown): CaptureValue | undefined {
	if (typeIs(value, "NumberSequence")) {
		return {
			NumberSequence: {
				keypoints: value.Keypoints.map((point) => {
					return {
						envelope: point.Envelope,
						time: point.Time,
						value: point.Value,
					};
				}),
			},
		};
	}

	if (typeIs(value, "ColorSequence")) {
		return {
			ColorSequence: {
				keypoints: value.Keypoints.map((point) => {
					return {
						color: [point.Value.R, point.Value.G, point.Value.B],
						time: point.Time,
					};
				}),
			},
		};
	}

	return undefined;
}

function encodeSpecial(value: unknown, context: ValueContext): CaptureValue | undefined {
	if (typeIs(value, "Instance")) {
		return context.reference(value);
	}

	if (typeIs(value, "SecurityCapabilities")) {
		return { CapabilityBits: context.io.capabilityBits(value) };
	}

	if (typeIs(value, "Font")) {
		return {
			Font: { family: value.Family, style: value.Style.Name, weight: value.Weight.Name },
		};
	}

	if (typeIs(value, "CFrame")) {
		const [x, y, z, xx, xy, xz, yx, yy, yz, zx, zy, zz] = value.GetComponents();
		return {
			CFrame: {
				orientation: [
					[xx, xy, xz],
					[yx, yy, yz],
					[zx, zy, zz],
				],
				position: [x, y, z],
			},
		};
	}

	return undefined;
}

function encodeValue(
	value: unknown,
	engineType: string,
	context: ValueContext,
	location: string,
): CaptureValue {
	return (
		encodeScalar(value, engineType) ??
		encodeVectors(value) ??
		encodeDimensions(value) ??
		encodeSequences(value) ??
		encodeSpecial(value, context) ??
		error(`${location}: unsupported capture value ${typeOf(value)} (${engineType})`)
	);
}
