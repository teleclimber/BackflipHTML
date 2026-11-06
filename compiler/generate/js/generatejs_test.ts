import { assertEquals } from "jsr:@std/assert";

import { interpretBackcode } from "../../backcode.ts";
import { generateFunction, generateStatement } from "./generatejs.ts";

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

Deno.test("plus expressions JS", () => {
	const cases: [string, string][] = [
		["a + b", "(a + b)"],
		["'abc' + 'def'", "('abc' + 'def')"],
		["a + b + c", "((a + b) + c)"],
		["a + b == c", "((a + b) == c)"],
	];
	cases.forEach(([input, expected]) => {
		const result = interpretBackcode(input);
		assertEquals(result.errs, []);
		const generated = generateStatement(result.expr!);
		assertEquals(generated, expected);
	});
});
Deno.test("logical, strict equality and arithmetic expressions JS", () => {
	const cases: [string, string][] = [
		["a && b", "(a && b)"],
		["a || b", "(a || b)"],
		["a && b || c", "((a && b) || c)"],
		["a || b && c", "(a || (b && c))"],
		["u && u.name", "(u && u.name)"],
		["a === b", "(a === b)"],
		["a !== b", "(a !== b)"],
		["a - b", "(a - b)"],
		["a * b - c / d", "((a * b) - (c / d))"],
		["a % 2 === 0", "((a % 2) === 0)"],
		["!(a && b)", "!(a && b)"],
	];
	cases.forEach(([input, expected]) => {
		const result = interpretBackcode(input);
		assertEquals(result.errs, []);
		assertEquals(generateStatement(result.expr!), expected);
	});
});

// The generated function, run with each case's inputs, must give the value the
// expression has in JS. Covers what the generator decides: grouping, member
// access and short-circuiting.
Deno.test("generated functions evaluate like the source expression", () => {
	const cases: { code: string; inputs: Record<string, unknown>; expected: unknown }[] = [
		// grouping and associativity
		{ code: "a + b + c",                  inputs: { a: 1, b: "y", c: 2 },             expected: "1y2" },
		{ code: "a - b - c",                  inputs: { a: 10, b: 3, c: 2 },              expected: 5 },
		{ code: "a + b * c",                  inputs: { a: 1, b: 2, c: 3 },               expected: 7 },
		{ code: "-a * b",                     inputs: { a: 2, b: 3 },                     expected: -6 },
		{ code: "p * q - d",                  inputs: { p: 10, q: 3, d: 5 },              expected: 25 },
		{ code: "a / b % c",                  inputs: { a: 1, b: 0, c: 2 },               expected: NaN },
		{ code: "a % (b / c)",                inputs: { a: 5, b: 1, c: 0 },               expected: 5 },
		{ code: "a + b == c",                 inputs: { a: 1, b: 2, c: 3 },               expected: true },
		{ code: "a + b < c",                  inputs: { a: 1, b: 2, c: 4 },               expected: true },
		{ code: "!(a == b)",                  inputs: { a: 1, b: 2 },                     expected: true },
		{ code: "!(a < b)",                   inputs: { a: 1, b: 2 },                     expected: false },
		{ code: "!!a",                        inputs: { a: "0" },                         expected: true },
		{ code: "!(a == b) ? c : d",          inputs: { a: 1, b: 1, c: "x", d: "y" },     expected: "y" },
		{ code: "ok ? 'yes:' + n : 'no'",     inputs: { ok: true, n: 5 },                 expected: "yes:5" },
		{ code: "ok ? 'yes:' + n : 'no'",     inputs: { ok: false, n: 5 },                expected: "no" },
		{ code: "n % 2 === 0 ? 'even' : 'odd'", inputs: { n: 4 },                         expected: "even" },
		{ code: "a && b || c",                inputs: { a: 0, b: "b", c: "c" },           expected: "c" },
		{ code: "a || b && c",                inputs: { a: 0, b: "b", c: "c" },           expected: "c" },
		{ code: "a && b ? 'y' : 'n'",         inputs: { a: 1, b: "" },                    expected: "n" },
		{ code: "a && b && c",                inputs: { a: 1, b: 2, c: 3 },               expected: 3 },
		// member access
		{ code: "u.name + '!'",               inputs: { u: { name: "hi" } },              expected: "hi!" },
		{ code: "a[k]",                       inputs: { a: { x: 42 }, k: "x" },           expected: 42 },
		{ code: "u.profile.name",             inputs: { u: { profile: { name: "A" } } },  expected: "A" },
		{ code: "a[b[c]]",                    inputs: { a: { x: 1, y: 2 }, b: { k: "y" }, c: "k" }, expected: 2 },
		{ code: "u.role == 'admin'",          inputs: { u: { role: "admin" } },           expected: true },
		{ code: "u.age >= 18",                inputs: { u: { age: 17 } },                 expected: false },
		// short-circuit: the right side would throw if evaluated
		{ code: "u && u.name",                inputs: { u: null },                        expected: null },
		{ code: "u && u.profile",             inputs: { u: { profile: { name: "A" } } },  expected: { name: "A" } },
		{ code: "a || b.c",                   inputs: { a: "x", b: null },                expected: "x" },
		{ code: "'count: ' + n",              inputs: { n: 5 },                           expected: "count: 5" },
	];
	for (const tc of cases) {
		const parsed = interpretBackcode(tc.code);
		assertEquals(parsed.errs, [], tc.code);
		const fn = new Function(`return ${generateFunction("", parsed)}`)();
		assertEquals(fn(...parsed.vars.map(v => tc.inputs[v])), tc.expected, tc.code);
	}
});
