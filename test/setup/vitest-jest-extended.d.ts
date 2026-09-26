// Types for the matchers `jest-extended.ts` registers. jest-extended declares
// them on a global `CustomMatchers`; this connects that to vitest's extension
// point.
/// <reference types="jest-extended" />

/* oxlint-disable typescript/no-empty-object-type -- declaration merge adds members */
declare module "vitest" {
	interface Matchers<
		R extends Promise<void> | void = Promise<void> | void,
		T = unknown,
	> extends CustomMatchers<R> {}
}

export {};
