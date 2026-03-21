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