import { assertEquals } from "jsr:@std/assert";

import type { ElementTNode } from "../../types.ts";
import { makeSequentialBfidGen } from "./bfid.ts";
import { ensureBfid } from "./mutate-ast.ts";

function el(attrs: any[] = []): ElementTNode {
	return { type: 'element', tagName: 'div', attrs, tnodes: [] };
}

Deno.test("appends data-bfid attr when missing", () => {
	const e = el([{ type: 'static', raw: ' class="x"' }]);
	const gen = makeSequentialBfidGen();
	const id = ensureBfid(e, gen);
	assertEquals(id, 'bf0');
	assertEquals(e.attrs.length, 2);
	assertEquals(e.attrs[1], { type: 'static', raw: ' data-bfid="bf0"' });
});

Deno.test("appends at end (after dynamic attrs)", () => {
	const e = el([
		{ type: 'static', raw: ' class="x"' },
		{ type: 'dynamic', name: 'title', expr: { expr: undefined, errs: [], vars: [] }, isBoolean: false },
	]);
	const gen = makeSequentialBfidGen();
	ensureBfid(e, gen);
	assertEquals(e.attrs.length, 3);
	assertEquals(e.attrs[2].type, 'static');
	assertEquals((e.attrs[2] as any).raw, ' data-bfid="bf0"');
});

Deno.test("reuses existing bfid", () => {
	const e = el([{ type: 'static', raw: ' data-bfid="existing-id"' }]);
	let calls = 0;
	const gen = () => { calls++; return 'never'; };
	const id = ensureBfid(e, gen);
	assertEquals(id, 'existing-id');
	assertEquals(calls, 0);
	assertEquals(e.attrs.length, 1);
});

Deno.test("reuses existing bfid embedded in larger static raw", () => {
	const e = el([{ type: 'static', raw: ' class="x" data-bfid="abc" role="row"' }]);
	const gen = makeSequentialBfidGen();
	const id = ensureBfid(e, gen);
	assertEquals(id, 'abc');
	assertEquals(e.attrs.length, 1);
});

Deno.test("two calls on same element return same id and only append once", () => {
	const e = el([]);
	const gen = makeSequentialBfidGen();
	const a = ensureBfid(e, gen);
	const b = ensureBfid(e, gen);
	assertEquals(a, b);
	assertEquals(a, 'bf0');
	assertEquals(e.attrs.length, 1);
});
