/** Current patch version, shared with the readable source distribution. */
export const VERSION = 5;

/**
 * Patched scripts and the stock hashes they replace. The sources are in
 * `rojo-plugin/patched/<name>.lua`; Node loads this module without them.
 */
export const PATCHES = [
	{
		name: "App",
		hash: "f7facea2cd39479ede1349b0042633c8228b8a41d602831f1928a1e43f7b1f15",
		olderHash: "4000a9940ca1584d58cb9c748cec7084e818e2d5b17e99ebe11bd34584898c9f",
		oldestHash: "6f2c0bc5ca581f2d0dd62da344fee033821a44ead7d55d800247f071f113bae9",
		previousHash: "4000a9940ca1584d58cb9c748cec7084e818e2d5b17e99ebe11bd34584898c9f",
	},
	{
		name: "ServeSession",
		hash: "e7a8fe67a0ff8229d13680fedfec2228fc2d23561bf2a512d1032bb7517c111a",
		olderHash: "2ed6224bb7fc40c4daff5f4b06adf0c22e2b9e0314b5341a1d00e464a5cf2592",
		oldestHash: "0ae6058c41a198e5a5cee72918809e9f67733669732895e3fee208dd0f6e1318",
		previousHash: "0c20c88433f3eed71733e932634a1eb65918f885d0d0e6a03046cb4f27652c54",
	},
] as const;
