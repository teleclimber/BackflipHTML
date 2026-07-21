import { assertEquals } from "jsr:@std/assert";

import type {
	ElementTNode, AttrPart, PrintTNode, ForTNode, IfTNode, IfBranch,
	SlotTNode, PartialRefTNode, TNode,
} from "../../types.ts";
import { interpretBackcode } from "../../backcode.ts";
import type { BackcodeSite, IfSetSite } from "./collect.ts";
import { qualifies } from "./filter.ts";

// These sites carry their own liveVars/otherVars split, so the set only matters
// for if-sets (which check expressions deep in their subtree).
const LIVE = new Set(['foo', 'bar', 'x', 'y', 'flag', 'used']);

function makeAttrSite(
	attrCode: string,
	liveVars: string[],
	otherVars: string[],
	inForLoop = false,
): BackcodeSite {
	const attr: AttrPart = { type: 'dynamic', name: 'title', expr: interpretBackcode(attrCode), isBoolean: false };
	const element: ElementTNode = { type: 'element', tagName: 'div', attrs: [attr], tnodes: [] };
	return {
		site: { kind: 'attr', element, attr: attr as any },
		parsed: attr.type === 'dynamic' ? attr.expr : interpretBackcode(attrCode),
		liveVars, otherVars, inForLoop,
	};
}

function makePrintSite(
	code: string,
	liveVars: string[],
	otherVars: string[],
	inForLoop = false,
): BackcodeSite {
	const node: PrintTNode = { type: 'print', data: interpretBackcode(code) };
	const container: PrintTNode[] = [node];
	return {
		site: { kind: 'print', node, container, parentElement: null },
		parsed: interpretBackcode(code),
		liveVars, otherVars, inForLoop,
	};
}

Deno.test("accepts pure-live print sites", () => {
	assertEquals(qualifies(makePrintSite('x', ['x'], []), LIVE), true);
});

Deno.test("print sites obey the cross-kind rules (no-live / mixed / in-for rejected)", () => {
	assertEquals(qualifies(makePrintSite('x', [], ['x']), LIVE), false);
	assertEquals(qualifies(makePrintSite('x + y', ['x'], ['y']), LIVE), false);
	assertEquals(qualifies(makePrintSite('x', ['x'], [], true), LIVE), false);
});

Deno.test("rejects still-unsupported kinds (e.g. for-iterable)", () => {
	const node: ForTNode = { type: 'for', iterable: interpretBackcode('items'), valName: 'item', tnodes: [] };
	const site: BackcodeSite = {
		site: { kind: 'for-iterable', node },
		parsed: interpretBackcode('items'),
		liveVars: ['items'], otherVars: [], inForLoop: false,
	};
	assertEquals(qualifies(site, LIVE), false);
});

Deno.test("rejects sites with no live vars (any kind)", () => {
	assertEquals(qualifies(makeAttrSite('bar', [], ['bar']), LIVE), false);
});

Deno.test("rejects sites that mix live and non-live vars", () => {
	assertEquals(qualifies(makeAttrSite('foo + bar', ['foo'], ['bar']), LIVE), false);
});

Deno.test("rejects sites inside for loop", () => {
	assertEquals(qualifies(makeAttrSite('foo', ['foo'], [], true), LIVE), false);
});

Deno.test("accepts attr sites that are pure-live", () => {
	assertEquals(qualifies(makeAttrSite('foo', ['foo'], []), LIVE), true);
});

Deno.test("accepts attr sites with multiple live vars", () => {
	assertEquals(qualifies(makeAttrSite('foo + bar', ['foo', 'bar'], []), LIVE), true);
});

Deno.test("accepts definition-root-attr sites that are pure-live", () => {
	const attr: AttrPart = { type: 'dynamic', name: 'class', expr: interpretBackcode('foo'), isBoolean: false };
	const site: BackcodeSite = {
		site: { kind: 'definition-root-attr', attr: attr as any },
		parsed: interpretBackcode('foo'),
		liveVars: ['foo'], otherVars: [], inForLoop: false,
	};
	assertEquals(qualifies(site, LIVE), true);
});

Deno.test("composes with Array.prototype.filter for the standard use", () => {
	const ok = makeAttrSite('foo', ['foo'], []);
	const inFor = makeAttrSite('foo', ['foo'], [], true);
	const mixed = makeAttrSite('foo + bar', ['foo'], ['bar']);
	const filtered = [ok, inFor, mixed].filter(s => qualifies(s, LIVE));
	assertEquals(filtered.length, 1);
	assertEquals(filtered[0], ok);
});

// --- if-sets ---------------------------------------------------------------
//
// An if-set qualifies only when the whole subtree can be re-rendered in the
// browser from live vars alone. Each test below flips exactly one rule.

const IF_LIVE = new Set(['a', 'b', 'items', 'name']);

function ifSet(branches: IfBranch[], over = IF_LIVE, flags: Partial<IfSetSite> = {}): IfSetSite {
	const node: IfTNode = { type: 'if', branches };
	const liveVars: string[] = [];
	const otherVars: string[] = [];
	for (const br of branches) {
		for (const v of br.condition?.vars ?? []) (over.has(v) ? liveVars : otherVars).push(v);
	}
	return {
		kind: 'if-set', node, container: [node], parentElement: null,
		liveVars, otherVars, inForLoop: false, inIfSet: false, ...flags,
	};
}

function branch(cond: string | null, tnodes: TNode[] = []): IfBranch {
	return cond === null ? { tnodes } : { condition: interpretBackcode(cond), tnodes };
}

Deno.test("if-set: simple live-var condition with a b-else qualifies", () => {
	assertEquals(qualifies(ifSet([branch('a'), branch(null)]), IF_LIVE), true);
});

Deno.test("if-set: a non-live var in any branch condition disqualifies the whole set", () => {
	assertEquals(qualifies(ifSet([branch('a'), branch('nope')]), IF_LIVE), false);
});

Deno.test("if-set: a condition with no variables disqualifies", () => {
	assertEquals(qualifies(ifSet([branch('a'), branch('1 == 1')]), IF_LIVE), false);
});

Deno.test("if-set: nested inside another set, or inside a b-for, is skipped", () => {
	assertEquals(qualifies(ifSet([branch('a')], IF_LIVE, { inIfSet: true }), IF_LIVE), false);
	assertEquals(qualifies(ifSet([branch('a')], IF_LIVE, { inForLoop: true }), IF_LIVE), false);
});

Deno.test("if-set: a non-live var deep in the subtree disqualifies", () => {
	const print: PrintTNode = { type: 'print', data: interpretBackcode('stranger') };
	const el: ElementTNode = { type: 'element', tagName: 'p', attrs: [], tnodes: [print] };
	assertEquals(qualifies(ifSet([branch('a', [el])]), IF_LIVE), false);
});

Deno.test("if-set: a non-live var in a dynamic attr deep in the subtree disqualifies", () => {
	const attr: AttrPart = { type: 'dynamic', name: 'title', expr: interpretBackcode('stranger'), isBoolean: false };
	const el: ElementTNode = { type: 'element', tagName: 'p', attrs: [attr], tnodes: [] };
	assertEquals(qualifies(ifSet([branch('a', [el])]), IF_LIVE), false);
});

Deno.test("if-set: a partial ref anywhere in the subtree disqualifies", () => {
	const ref: PartialRefTNode = {
		type: 'partial-ref', kind: 'custom-element', file: null, partialName: 'my-card',
		slots: {}, bindings: [],
	};
	assertEquals(qualifies(ifSet([branch('a', [ref])]), IF_LIVE), false);
});

Deno.test("if-set: a slot anywhere in the subtree disqualifies", () => {
	const slot: SlotTNode = { type: 'slot', name: undefined };
	assertEquals(qualifies(ifSet([branch('a', [slot])]), IF_LIVE), false);
});

Deno.test("if-set: asset references disqualify (unresolved, dynamic and static forms)", () => {
	const unresolved: AttrPart = {
		type: 'asset', attrName: 'src', originalValue: '@img/a.png',
		refs: [{ name: 'img', subpath: 'a.png' }],
	};
	const dynamicAsset: AttrPart = {
		type: 'dynamic', name: 'src', expr: interpretBackcode('name'), isBoolean: false, isAsset: true,
	};
	const staticAsset: AttrPart = { type: 'static', raw: ' src="@img/a.png"' };
	for (const attr of [unresolved, dynamicAsset, staticAsset]) {
		const el: ElementTNode = { type: 'element', tagName: 'img', attrs: [attr], tnodes: [] };
		assertEquals(qualifies(ifSet([branch('a', [el])]), IF_LIVE), false);
	}
});

Deno.test("if-set: a nested b-for over a live var qualifies, and binds its value name", () => {
	// `item` is not a live var, but it is locally bound by the loop.
	const print: PrintTNode = { type: 'print', data: interpretBackcode('item.label') };
	const li: ElementTNode = { type: 'element', tagName: 'li', attrs: [], tnodes: [print] };
	const forNode: ForTNode = {
		type: 'for', iterable: interpretBackcode('items'), valName: 'item', tnodes: [li],
	};
	assertEquals(qualifies(ifSet([branch('a', [forNode])]), IF_LIVE), true);
});

Deno.test("if-set: a b-for value name does not leak past the loop body", () => {
	const forNode: ForTNode = {
		type: 'for', iterable: interpretBackcode('items'), valName: 'item', tnodes: [],
	};
	const stray: PrintTNode = { type: 'print', data: interpretBackcode('item') };
	assertEquals(qualifies(ifSet([branch('a', [forNode, stray])]), IF_LIVE), false);
});

Deno.test("if-set: a nested b-if over live vars qualifies", () => {
	const nested: IfTNode = { type: 'if', branches: [branch('b'), branch(null)] };
	assertEquals(qualifies(ifSet([branch('a', [nested])]), IF_LIVE), true);
});

Deno.test("if-set: a nested b-if over a non-live var disqualifies the outer set", () => {
	const nested: IfTNode = { type: 'if', branches: [branch('stranger')] };
	assertEquals(qualifies(ifSet([branch('a', [nested])]), IF_LIVE), false);
});
