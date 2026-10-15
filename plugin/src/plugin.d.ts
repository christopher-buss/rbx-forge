/// <reference types="@rbxts/types/plugin" />

declare const SecurityCapabilities: SecurityCapabilitiesConstructor;

interface SecurityCapabilities {
	Contains(this: SecurityCapabilities, ...capabilities: Array<Enum.SecurityCapability>): boolean;
}
