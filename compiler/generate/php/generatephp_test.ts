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

Deno.test("ternary expressions PHP", () => {
	const cases: [string, string][] = [
		["a ? b : c",                            "($a ? $b : $c)"],
		["a ? b : c ? d : e",                    "($a ? $b : ($c ? $d : $e))"],
		["user.admin ? user.name : 'guest'",     "($user['admin'] ? $user['name'] : 'guest')"],
		["!(a ? b : c)",                         "!($a ? $b : $c)"],
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
		["a == b",                    "($a == $b)"],
		["a != b",                    "($a != $b)"],
		["a.x == b[c]",               "($a['x'] == $b[$c])"],
		["user.name == 'admin'",      "($user['name'] == 'admin')"],
		["a == b ? c : d",            "(($a == $b) ? $c : $d)"],
		["!(a == b)",                 "!($a == $b)"],
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
		["a + b",                "((is_string($a) || is_string($b)) ? ($a . $b) : ($a + $b))"],
		["'abc' + 'def'",        "((is_string('abc') || is_string('def')) ? ('abc' . 'def') : ('abc' + 'def'))"],
		["user.name + '!'",      "((is_string($user['name']) || is_string('!')) ? ($user['name'] . '!') : ($user['name'] + '!'))"],
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
