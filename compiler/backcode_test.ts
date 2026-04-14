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