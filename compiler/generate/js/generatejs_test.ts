import { assertEquals } from "jsr:@std/assert";

import { interpretBackcode } from "../../backcode.ts";
import { generateStatement } from "./generatejs.ts";

Deno.test( "simple accessor code", () => {
	[
		"abc",
		"abc.def",
		"abc[def]",
		"abc[def].ghi",
		"abc.def.ghi",
		"abc[def[ghi]]",
		"'abc'",
		'"abc"',
		"abc[123]",
		"abc['def']"
	].forEach( s => {
		const result = interpretBackcode(s);
		const generated = generateStatement(result.expr!);
		console.log("gen", generated)
		assertEquals(s, generated);
	})
});

Deno.test( "unary expressions JS", () => {
	[
		"!abc",
		"-abc",
		"+abc",
		"!abc.def",
		"!!abc",
	].forEach( s => {
		const result = interpretBackcode(s);
		assertEquals(result.errs, []);
		const generated = generateStatement(result.expr!);
		assertEquals(s, generated);
	})
});

Deno.test("ternary expressions JS", () => {
	const cases: [string, string][] = [
		["a ? b : c", "(a ? b : c)"],
		["a ? b : c ? d : e", "(a ? b : (c ? d : e))"],
		['user.admin ? user.name : "guest"', '(user.admin ? user.name : "guest")'],
		["!(a ? b : c)", "!(a ? b : c)"],
	];
	cases.forEach(([input, expected]) => {
		const result = interpretBackcode(input);
		assertEquals(result.errs, []);
		const generated = generateStatement(result.expr!);
		assertEquals(generated, expected);
	});
});

Deno.test("equality expressions JS", () => {
	const cases: [string, string][] = [
		["a == b", "(a == b)"],
		["a != b", "(a != b)"],
		["a.x == b[c]", "(a.x == b[c])"],
		["a == b ? c : d", "((a == b) ? c : d)"],
		["!(a == b)", "!(a == b)"],
	];
	cases.forEach(([input, expected]) => {
		const result = interpretBackcode(input);
		assertEquals(result.errs, []);
		const generated = generateStatement(result.expr!);
		assertEquals(generated, expected);
	});
});