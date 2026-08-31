import { assertEquals } from "jsr:@std/assert";
import { visitTNodes, mapTNodes, appendCoalesced } from "./walk.ts";
import type { TNode } from "./types.ts";

function raw(s: string): TNode { return { type: 'raw', raw: s }; }

Deno.test("visitTNodes visits all containers including slot contents", () => {
	const tree: TNode[] = [
		raw('a'),
		{ type: 'for', iterable: { errs: [], vars: [], expr: null } as any, valName: 'x', tnodes: [raw('in-for')] },
		{ type: 'if', branches: [
			{ condition: { errs: [], vars: [], expr: null } as any, tnodes: [raw('in-if-1')] },
			{ tnodes: [raw('in-if-2')] },
		] },
		{ type: 'element', tagName: 'div', attrs: [], tnodes: [raw('in-elem')] },
		{ type: 'partial-ref', kind: 'b-part', file: null, partialName: 'p', bindings: [],
			slots: { default: [raw('in-slot')] } },
	];
	const seen: string[] = [];
	visitTNodes(tree, (n) => { if (n.type === 'raw') seen.push(n.raw); });
	assertEquals(seen, ['a', 'in-for', 'in-if-1', 'in-if-2', 'in-elem', 'in-slot']);
});

Deno.test("visitTNodes visits IfBranch tnodes but not the branch objects", () => {
	const tree: TNode[] = [
		{ type: 'if', branches: [{ tnodes: [raw('x')] }] },
	];
	const types: string[] = [];
	visitTNodes(tree, (n) => types.push(n.type));
	assertEquals(types, ['if', 'raw']);
});

Deno.test("mapTNodes identity mapping deep-equals input", () => {
	const tree: TNode[] = [
		raw('a'),
		{ type: 'element', tagName: 'div', attrs: [], tnodes: [
			{ type: 'for', iterable: { errs: [], vars: [], expr: null } as any, valName: 'x', tnodes: [raw('b')] },
		] },
	];
	const out = mapTNodes(tree, (n) => n);
	assertEquals(out, tree);
});

Deno.test("mapTNodes preserves unknown extra fields via spread", () => {
	const tree: TNode[] = [
		{ type: 'element', tagName: 'div', attrs: [], tnodes: [], extraField: 42 } as any,
	];
	const out = mapTNodes(tree, (n) => n);
	assertEquals((out[0] as any).extraField, 42);
});

Deno.test("mapTNodes coalesceRaws merges adjacent raws in produced lists", () => {
	// fn turns every print into a raw, producing adjacent raws to merge.
	const tree: TNode[] = [
		raw('a'),
		{ type: 'print', data: { errs: [], vars: [], expr: null } as any },
		raw('b'),
	];
	const out = mapTNodes(tree, (n) => n.type === 'print' ? raw('P') : n, { coalesceRaws: true });
	assertEquals(out, [raw('aPb')]);
});

Deno.test("mapTNodes without coalesceRaws keeps adjacent raws separate", () => {
	const tree: TNode[] = [raw('a'), raw('b')];
	const out = mapTNodes(tree, (n) => n);
	assertEquals(out, [raw('a'), raw('b')]);
});

Deno.test("mapTNodes does not mutate the input tree", () => {
	const inner = raw('a');
	const el: TNode = { type: 'element', tagName: 'div', attrs: [], tnodes: [inner] };
	const tree: TNode[] = [el];
	const snapshot = structuredClone(tree);
	const out = mapTNodes(tree, (n) => n.type === 'raw' ? raw(n.raw + '!') : n);
	assertEquals(tree, snapshot);       // input untouched
	assertEquals((out[0] as any).tnodes[0].raw, 'a!');  // output transformed
});

Deno.test("mapTNodes shares parsed expression objects by reference", () => {
	const iterable = { errs: [], vars: ['xs'], expr: null } as any;
	const tree: TNode[] = [{ type: 'for', iterable, valName: 'x', tnodes: [] }];
	const out = mapTNodes(tree, (n) => n);
	assertEquals((out[0] as any).iterable === iterable, true);
});

Deno.test("appendCoalesced merges trailing raw, pushes otherwise", () => {
	const arr: TNode[] = [];
	appendCoalesced(arr, raw('a'));
	appendCoalesced(arr, raw('b'));
	assertEquals(arr, [raw('ab')]);
	appendCoalesced(arr, { type: 'slot', name: undefined });
	appendCoalesced(arr, raw('c'));
	assertEquals(arr.length, 3);
	assertEquals(arr[2], raw('c'));
});
