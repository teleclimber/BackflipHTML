import { assertEquals, assertThrows } from "jsr:@std/assert";

import type { RootRNode, RawRNode, PrintRNode, ForRNode, IfRNode, rfn } from "./render.ts";
import { render, renderRoot } from "./render.ts";

function makeFn(code: string, vars: string[]): rfn {
	return { fn: new Function(...vars, `return ${code};`), vars };
}

Deno.test("raw node", () => {
	assertEquals(render({ type: 'raw', raw: '<p>hello</p>' }, {}), '<p>hello</p>');
});

Deno.test("print node", () => {
	const node: PrintRNode = { type: 'print', data: makeFn('name', ['name']) };
	assertEquals(render(node, { name: 'world' }), 'world');
});

Deno.test("for node", () => {
	const node: ForRNode = {
		type: 'for',
		iterable: makeFn('items', ['items']),
		valName: 'item',
		nodes: [
			{ type: 'raw', raw: '<li>' },
			{ type: 'print', data: makeFn('item', ['item']) },
			{ type: 'raw', raw: '</li>' },
		]
	};
	assertEquals(render(node, { items: ['a', 'b'] }), '<li>a</li><li>b</li>');
});

Deno.test("for node with non-iterable throws", () => {
	const node: ForRNode = {
		type: 'for',
		iterable: makeFn('42', []),
		valName: 'item',
		nodes: []
	};
	assertThrows(() => render(node, {}), Error, "iterable not iterable");
});

Deno.test("if node - true condition", () => {
	const node: IfRNode = {
		type: 'if',
		branches: [{
			condition: makeFn('show', ['show']),
			nodes: [{ type: 'raw', raw: 'yes' }]
		}]
	};
	assertEquals(render(node, { show: true }), 'yes');
});

Deno.test("if node - false condition", () => {
	const node: IfRNode = {
		type: 'if',
		branches: [{
			condition: makeFn('show', ['show']),
			nodes: [{ type: 'raw', raw: 'yes' }]
		}]
	};
	assertEquals(render(node, { show: false }), '');
});

Deno.test("if/else - true branch", () => {
	const node: IfRNode = {
		type: 'if',
		branches: [
			{ condition: makeFn('show', ['show']), nodes: [{ type: 'raw', raw: 'yes' }] },
			{ condition: undefined, nodes: [{ type: 'raw', raw: 'no' }] },
		]
	};
	assertEquals(render(node, { show: true }), 'yes');
});

Deno.test("if/else - false branch", () => {
	const node: IfRNode = {
		type: 'if',
		branches: [
			{ condition: makeFn('show', ['show']), nodes: [{ type: 'raw', raw: 'yes' }] },
			{ condition: undefined, nodes: [{ type: 'raw', raw: 'no' }] },
		]
	};
	assertEquals(render(node, { show: false }), 'no');
});

Deno.test("if/else-if/else picks first truthy branch", () => {
	const node: IfRNode = {
		type: 'if',
		branches: [
			{ condition: makeFn('a', ['a']), nodes: [{ type: 'raw', raw: '1' }] },
			{ condition: makeFn('b', ['b']), nodes: [{ type: 'raw', raw: '2' }] },
			{ condition: undefined, nodes: [{ type: 'raw', raw: '3' }] },
		]
	};
	assertEquals(render(node, { a: false, b: true }), '2');
	assertEquals(render(node, { a: true, b: true }), '1');
	assertEquals(render(node, { a: false, b: false }), '3');
});

Deno.test("if branch can contain print nodes", () => {
	const node: IfRNode = {
		type: 'if',
		branches: [{
			condition: makeFn('true', []),
			nodes: [
				{ type: 'raw', raw: 'hello ' },
				{ type: 'print', data: makeFn('name', ['name']) },
			]
		}]
	};
	assertEquals(render(node, { name: 'world' }), 'hello world');
});

Deno.test("for inside if", () => {
	const node: IfRNode = {
		type: 'if',
		branches: [{
			condition: makeFn('show', ['show']),
			nodes: [{
				type: 'for',
				iterable: makeFn('items', ['items']),
				valName: 'item',
				nodes: [{ type: 'print', data: makeFn('item', ['item']) }]
			}]
		}]
	};
	assertEquals(render(node, { show: true, items: ['a', 'b'] }), 'ab');
	assertEquals(render(node, { show: false, items: ['a', 'b'] }), '');
});

Deno.test("if inside for", () => {
	const node: ForRNode = {
		type: 'for',
		iterable: makeFn('items', ['items']),
		valName: 'item',
		nodes: [{
			type: 'if',
			branches: [
				{ condition: makeFn('item.show', ['item']), nodes: [{ type: 'print', data: makeFn('item.name', ['item']) }] },
			]
		}]
	};
	const ctx = { items: [{ name: 'a', show: true }, { name: 'b', show: false }, { name: 'c', show: true }] };
	assertEquals(render(node, ctx), 'ac');
});

Deno.test("renderRoot", () => {
	const root: RootRNode = {
		type: 'root',
		nodes: [
			{ type: 'raw', raw: '<p>' },
			{ type: 'print', data: makeFn('x', ['x']) },
			{ type: 'raw', raw: '</p>' },
		]
	};
	assertEquals(renderRoot(root, { x: 'hi' }), '<p>hi</p>');
});

Deno.test("for node with empty iterable", () => {
	const node: ForRNode = {
		type: 'for',
		iterable: makeFn('items', ['items']),
		valName: 'item',
		nodes: [{ type: 'raw', raw: 'nope' }]
	};
	assertEquals(render(node, { items: [] }), '');
});

Deno.test("for loop context does not leak between iterations", () => {
	const node: ForRNode = {
		type: 'for',
		iterable: makeFn('items', ['items']),
		valName: 'item',
		nodes: [{ type: 'print', data: makeFn('item', ['item']) }]
	};
	assertEquals(render(node, { items: ['x', 'y', 'z'] }), 'xyz');
});

Deno.test("for loop does not mutate outer context", () => {
	const node: ForRNode = {
		type: 'for',
		iterable: makeFn('items', ['items']),
		valName: 'item',
		nodes: [{ type: 'print', data: makeFn('item', ['item']) }]
	};
	const ctx = { items: ['a'], item: 'original' };
	render(node, ctx);
	assertEquals(ctx.item, 'original');
});
