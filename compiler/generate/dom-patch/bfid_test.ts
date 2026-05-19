import { assertEquals, assertNotEquals } from "jsr:@std/assert";

import { makeBfidGen, makeSequentialBfidGen } from "./bfid.ts";

Deno.test("sequential gen produces stable sequence", () => {
	const gen = makeSequentialBfidGen();
	assertEquals(gen(), 'bf0');
	assertEquals(gen(), 'bf1');
	assertEquals(gen(), 'bf2');
});

Deno.test("sequential gen accepts custom prefix", () => {
	const gen = makeSequentialBfidGen('x');
	assertEquals(gen(), 'x0');
	assertEquals(gen(), 'x1');
});

Deno.test("default gen produces distinct strings", () => {
	const gen = makeBfidGen();
	const seen = new Set<string>();
	for (let i = 0; i < 100; i++) seen.add(gen());
	assertEquals(seen.size, 100);
});

Deno.test("default gen uses given prefix", () => {
	const gen = makeBfidGen({ prefix: 'q' });
	for (let i = 0; i < 10; i++) {
		const id = gen();
		assertEquals(id.startsWith('q'), true);
		assertNotEquals(id, 'q');
	}
});

Deno.test("default gen produces valid attribute-friendly chars only", () => {
	const gen = makeBfidGen();
	const re = /^[A-Za-z0-9]+$/;
	for (let i = 0; i < 20; i++) {
		const id = gen();
		assertEquals(re.test(id), true, `unexpected chars in ${id}`);
	}
});
