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
		["!abc",      "!backflip_isTruthy($abc)"],
		["-abc",      "-$abc"],
		["+abc",      "+$abc"],
		["!abc.def",  "!backflip_isTruthy($abc['def'])"],
	];

	cases.forEach(([input, expected]) => {
		const result = interpretBackcode(input);
		assertEquals(result.errs, []);
		const generated = generatePhpStatement(result.expr!);
		assertEquals(generated, expected);
	});
});

Deno.test("ternary expressions PHP", () => {
	const cases: [string, string][] = [
		["a ? b : c",                            "(backflip_isTruthy($a) ? $b : $c)"],
		["a ? b : c ? d : e",                    "(backflip_isTruthy($a) ? $b : (backflip_isTruthy($c) ? $d : $e))"],
		["user.admin ? user.name : 'guest'",     "(backflip_isTruthy($user['admin']) ? $user['name'] : 'guest')"],
		["!(a ? b : c)",                         "!backflip_isTruthy((backflip_isTruthy($a) ? $b : $c))"],
	];
	cases.forEach(([input, expected]) => {
		const result = interpretBackcode(input);
		assertEquals(result.errs, []);
		const generated = generatePhpStatement(result.expr!);
		assertEquals(generated, expected);
	});
});

Deno.test("equality expressions PHP", () => {
	const cases: [string, string][] = [
		["a == b",                    "backflip_jsLooseEq($a, $b)"],
		["a != b",                    "!backflip_jsLooseEq($a, $b)"],
		["a.x == b[c]",               "backflip_jsLooseEq($a['x'], $b[$c])"],
		["user.name == 'admin'",      "backflip_jsLooseEq($user['name'], 'admin')"],
		["a == b ? c : d",            "(backflip_isTruthy(backflip_jsLooseEq($a, $b)) ? $c : $d)"],
		["!(a == b)",                 "!backflip_isTruthy(backflip_jsLooseEq($a, $b))"],
	];
	cases.forEach(([input, expected]) => {
		const result = interpretBackcode(input);
		assertEquals(result.errs, []);
		const generated = generatePhpStatement(result.expr!);
		assertEquals(generated, expected);
	});
});

Deno.test("plus expressions PHP", () => {
	const cases: [string, string][] = [
		["a + b",                "backflip_jsPlus($a, $b)"],
		["'abc' + 'def'",        "backflip_jsPlus('abc', 'def')"],
		["user.name + '!'",      "backflip_jsPlus($user['name'], '!')"],
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
