import { describe, expect, it } from "vitest";

import { catchForgeError } from "../../test/helpers/errors.ts";
import { parseSourcemap } from "./sourcemap.ts";

const FILE = ".forge/sourcemap.json";

/** Rojo's output for a place with one model, keys in Rojo's order. */
const PLACE = [
	'{"name":"game","className":"DataModel","filePaths":["default.project.json"],"children":[',
	'{"name":"Workspace","className":"Workspace","children":[',
	'{"name":"Map","className":"Model","filePaths":["map.rbxm"]}]}]}',
].join("");

describe(parseSourcemap, () => {
	it("should read the instance tree and keep keys it does not use", () => {
		expect.assertions(1);

		expect(parseSourcemap(PLACE, FILE)).toStrictEqual(JSON.parse(PLACE));
	});

	it("should read a place with no children", () => {
		expect.assertions(1);

		const text = '{"name":"game","className":"DataModel"}';

		expect(parseSourcemap(text, FILE)).toStrictEqual(JSON.parse(text));
	});

	it("should fail with sourcemap_invalid for text that is not JSON", () => {
		expect.assertions(3);

		const error = catchForgeError(() => parseSourcemap("{", FILE));

		expect(error.code).toBe("sourcemap_invalid");
		expect(error.message).toStartWith(`Rojo wrote a sourcemap forge cannot read (${FILE}):\n`);
		expect(error.hint).toBe("Check that rojoAlias runs Rojo, not another tool.");
	});

	it("should name each value that breaks the shape", () => {
		expect.assertions(2);

		const text = [
			'{"name":"game","className":"DataModel","children":[',
			'{"name":5,"className":"Workspace"},{"name":"Lighting"}]}',
		].join("");
		const error = catchForgeError(() => parseSourcemap(text, FILE));

		expect(error.code).toBe("sourcemap_invalid");
		expect(error.message).toBe(
			[
				`Rojo wrote a sourcemap forge cannot read (${FILE}):`,
				"children[0].name must be a string (was a number)",
				"children[1].className must be a string (was missing)",
			].join("\n"),
		);
	});

	it("should refuse the sourcemap of a model project", () => {
		expect.assertions(2);

		const error = catchForgeError(() => {
			return parseSourcemap('{"name":"Tool","className":"Folder"}', FILE);
		});

		expect(error.code).toBe("sourcemap_invalid");
		expect(error.message).toBe(
			"The Rojo project's root is a Folder, not a DataModel: forge typegen types the services of a place.",
		);
	});
});
