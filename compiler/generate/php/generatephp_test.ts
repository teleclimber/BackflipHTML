import { assertEquals } from "jsr:@std/assert";

import { interpretBackcode } from "../../backcode.ts";
import { generatePhpStatement, generatePhpFunction } from "./generatephp.ts";

Deno.test("simple accessor code PHP", () => {
	const cases: [string, string][] = [
		["abc",             "$abc"],
		["abc.def",         "$abc['def']"],
		["abc[def]",        "$abc[$def]"],
		["abc[def].ghi",    "$abc[$def]['ghi']"],
		["abc.def.ghi",     "$abc['def']['ghi']"],
		["abc[def[ghi]]",   "$abc[$def[$ghi]]"],
		["42",              "42"],
		["'abc'",           "'abc'"],
		['"abc"',           '"abc"'],
		["abc[0]",          "$abc[0]"],
		["abc['def']",      "$abc['def']"],
	];

	cases.forEach(([input, expected]) => {
		const result = interpretBackcode(input);
		const generated = generatePhpStatement(result.expr!);
		console.log("gen", generated);
		assertEquals(generated, expected);
	});
});

Deno.test("unary expressions PHP", () => {
	const cases: [string, string][] = [
		["!abc",      "!$abc"],
		["-abc",      "-$abc"],
		["+abc",      "+$abc"],
		["!abc.def",  "!$abc['def']"],
	];

	cases.forEach(([input, expected]) => {
		const result = interpretBackcode(input);
		assertEquals(result.errs, []);
		const generated = generatePhpStatement(result.expr!);
		assertEquals(generated, expected);
	});
});

Deno.test("generatePhpFunction", () => {
	assertEquals(
		generatePhpFunction('', interpretBackcode('user.name')),
		"function($user) { return $user['name']; }"
	);

	assertEquals(
		generatePhpFunction('', interpretBackcode('post.title')),
		"function($post) { return $post['title']; }"
	);

	assertEquals(
		generatePhpFunction('', interpretBackcode('42')),
		"function() { return 42; }"
	);
});
