import { assertEquals } from "jsr:@std/assert";
import { interpretBackcode } from "./backcode.ts";

Deno.test("interpretBackcode: allowed unary operators produce no errors", () => {
	["!abc", "-abc", "+abc", "!!abc", "!abc.def"].forEach(s => {
		const result = interpretBackcode(s);
		assertEquals(result.errs, [], `expected no errors for: ${s}`);
	});
});

Deno.test("interpretBackcode: disallowed unary operators produce errors", () => {
	["typeof abc", "void abc", "delete abc"].forEach(s => {
		const result = interpretBackcode(s);
		assertEquals(result.errs.length > 0, true, `expected error for: ${s}`);
	});
});

Deno.test("interpretBackcode: ternary expression", () => {
	const result = interpretBackcode('a ? b : c');
	assertEquals(result.errs, []);
	assertEquals(result.vars, ['a', 'b', 'c']);
});

Deno.test("interpretBackcode: ternary with member access", () => {
	const result = interpretBackcode('a ? b.c : d[e]');
	assertEquals(result.errs, []);
	assertEquals(result.vars, ['a', 'b', 'd', 'e']);
});

Deno.test("interpretBackcode: equality operators", () => {
	(['==', '!='] as const).forEach(op => {
		const result = interpretBackcode(`a ${op} b`);
		assertEquals(result.errs, [], `expected no errors for: a ${op} b`);
		assertEquals(result.vars, ['a', 'b']);
	});
});

Deno.test("interpretBackcode: equality with member access on both sides", () => {
	const result = interpretBackcode('a.x == b[c]');
	assertEquals(result.errs, []);
	assertEquals(result.vars, ['a', 'b', 'c']);
});

Deno.test("interpretBackcode: equality composes with unary and ternary", () => {
	const negated = interpretBackcode('!(a == b)');
	assertEquals(negated.errs, []);
	assertEquals(negated.vars, ['a', 'b']);

	const ternary = interpretBackcode('a == b ? c : d');
	assertEquals(ternary.errs, []);
	assertEquals(ternary.vars, ['a', 'b', 'c', 'd']);
});

Deno.test("interpretBackcode: plus operator", () => {
	const result = interpretBackcode('a + b');
	assertEquals(result.errs, []);
	assertEquals(result.vars, ['a', 'b']);

	const literals = interpretBackcode("'abc' + 'def'");
	assertEquals(literals.errs, []);
	assertEquals(literals.vars, []);

	const mixed = interpretBackcode("'prefix' + name");
	assertEquals(mixed.errs, []);
	assertEquals(mixed.vars, ['name']);

	const chained = interpretBackcode('a + b + c');
	assertEquals(chained.errs, []);
	assertEquals(chained.vars, ['a', 'b', 'c']);
});

Deno.test("interpretBackcode: disallowed binary operators produce errors", () => {
	['a === b', 'a !== b', 'a > b', 'a < b', 'a && b', 'a || b'].forEach(s => {
		const result = interpretBackcode(s);
		assertEquals(result.errs.length > 0, true, `expected error for: ${s}`);
	});
});