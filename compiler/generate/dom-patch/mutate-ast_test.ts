import { assertEquals } from "jsr:@std/assert";

import type { ElementTNode, PrintTNode, TNode } from "../../types.ts";
import { interpretBackcode } from "../../backcode.ts";
import { makeSequentialBfidGen } from "./bfid.ts";
import { ensureBfid, ensureCommentsAround } from "./mutate-ast.ts";

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

Deno.test("ensureCommentsAround brackets the node with two comment siblings and returns their ids", () => {
	const print: PrintTNode = { type: 'print', data: interpretBackcode('x') };
	const container: TNode[] = [
		{ type: 'raw', raw: 'Some text ' },
		print,
		{ type: 'raw', raw: ' more text.' },
	];
	const ids = ensureCommentsAround(container, print, makeSequentialBfidGen());
	assertEquals(ids, { startId: 'bf0', endId: 'bf1' });
	assertEquals(container.length, 5);
	assertEquals(container[0], { type: 'raw', raw: 'Some text ' });
	assertEquals(container[1], { type: 'comment', text: 'bfid:bf0' });
	assertEquals(container[2], print);
	assertEquals(container[3], { type: 'comment', text: 'bfid:bf1' });
	assertEquals(container[4], { type: 'raw', raw: ' more text.' });
});

Deno.test("ensureCommentsAround handles a node at the start of its container", () => {
	const print: PrintTNode = { type: 'print', data: interpretBackcode('x') };
	const container: TNode[] = [print];
	ensureCommentsAround(container, print, makeSequentialBfidGen());
	assertEquals(container.map(n => n.type), ['comment', 'print', 'comment']);
});

Deno.test("ensureCommentsAround is idempotent: a second call reuses the markers and generates nothing", () => {
	const print: PrintTNode = { type: 'print', data: interpretBackcode('x') };
	const container: TNode[] = [{ type: 'raw', raw: 'a' }, print, { type: 'raw', raw: 'b' }];
	const first = ensureCommentsAround(container, print, makeSequentialBfidGen());

	let calls = 0;
	const gen = () => { calls++; return 'never'; };
	const second = ensureCommentsAround(container, print, gen);
	assertEquals(second, first);       // same ids
	assertEquals(calls, 0);            // no new ids generated
	assertEquals(container.length, 5); // no new comments spliced in
});

Deno.test("ensureCommentsAround throws when the node is not in the container", () => {
	const print: PrintTNode = { type: 'print', data: interpretBackcode('x') };
	let threw = false;
	try {
		ensureCommentsAround([], print, makeSequentialBfidGen());
	} catch (e) {
		threw = true;
		assertEquals(String(e).includes('not found in its container'), true);
	}
	assertEquals(threw, true);
});
