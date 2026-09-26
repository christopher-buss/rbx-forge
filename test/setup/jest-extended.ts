import * as matchers from "jest-extended";
import { expect } from "vitest";

// jest-extended types its exports as matcher signatures, not as the raw
// matcher functions `expect.extend` takes; the runtime values are the latter.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
expect.extend(matchers as unknown as Parameters<typeof expect.extend>[0]);
