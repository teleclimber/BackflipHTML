import { assertEquals } from "jsr:@std/assert";

import type { ElementTNode, PrintTNode, TNode } from "../../types.ts";
import { interpretBackcode } from "../../backcode.ts";
import { makeSequentialBfidGen } from "./bfid.ts";
import { ensureBfid, insertCommentsAround } from "./mutate-ast.ts";

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

Deno.test("insertCommentsAround brackets the node with two comment siblings", () => {
	const print: PrintTNode = { type: 'print', data: interpretBackcode('x') };
	const container: TNode[] = [
		{ type: 'raw', raw: 'Some text ' },
		print,
		{ type: 'raw', raw: ' more text.' },
	];
	insertCommentsAround(container, print, 'bfid:bf1', 'bfid:bf2');
	assertEquals(container.length, 5);
	assertEquals(container[0], { type: 'raw', raw: 'Some text ' });
	assertEquals(container[1], { type: 'comment', text: 'bfid:bf1' });
	assertEquals(container[2], print);
	assertEquals(container[3], { type: 'comment', text: 'bfid:bf2' });
	assertEquals(container[4], { type: 'raw', raw: ' more text.' });
});

Deno.test("insertCommentsAround handles a node at the start of its container", () => {
	const print: PrintTNode = { type: 'print', data: interpretBackcode('x') };
	const container: TNode[] = [print];
	insertCommentsAround(container, print, 'bfid:bf1', 'bfid:bf2');
	assertEquals(container.map(n => n.type), ['comment', 'print', 'comment']);
});

Deno.test("insertCommentsAround throws when the node is not in the container", () => {
	const print: PrintTNode = { type: 'print', data: interpretBackcode('x') };
	let threw = false;
	try {
		insertCommentsAround([], print, 'a', 'b');
	} catch (e) {
		threw = true;
		assertEquals(String(e).includes('not found in its container'), true);
	}
	assertEquals(threw, true);
});
