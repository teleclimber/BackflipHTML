import { assertEquals } from "jsr:@std/assert";

import type {
	ElementTNode, AttrPart, PrintTNode, ForTNode, IfTNode, IfBranch,
	SlotTNode, PartialRefTNode, TNode,
} from "../../types.ts";
import { interpretBackcode } from "../../backcode.ts";
import type { BackcodeSite, IfSetSite } from "./collect.ts";
import { qualifies } from "./filter.ts";

// Every variable a site can name is one of the partial's declared attributes, so
// there is no live-var set to qualify against — only where a site sits and what
// its subtree contains.

function makeAttrSite(attrCode: string, liveVars: string[], inForLoop = false): BackcodeSite {
	const attr: AttrPart = { type: 'dynamic', name: 'title', expr: interpretBackcode(attrCode), isBoolean: false };
	const element: ElementTNode = { type: 'element', tagName: 'div', attrs: [attr], tnodes: [] };
	return {
		site: { kind: 'attr', element, attr: attr as any },
		parsed: attr.type === 'dynamic' ? attr.expr : interpretBackcode(attrCode),
		liveVars, inForLoop,
	};
}

function makePrintSite(code: string, liveVars: string[], inForLoop = false): BackcodeSite {
	const node: PrintTNode = { type: 'print', data: interpretBackcode(code) };
	const container: PrintTNode[] = [node];
	return {
		site: { kind: 'print', node, container, parentElement: null },
		parsed: interpretBackcode(code),
		liveVars, inForLoop,
	};
}

Deno.test("accepts print sites", () => {
	assertEquals(qualifies(makePrintSite('x', ['x'])), true);
});

Deno.test("rejects a site whose expression names no variable", () => {
	// Nothing could ever change it, so it is not a patch site.
	assertEquals(qualifies(makePrintSite(`'static'`, [])), false);
	assertEquals(qualifies(makeAttrSite(`'static'`, [])), false);
});

Deno.test("rejects sites inside a b-for", () => {
	assertEquals(qualifies(makePrintSite('x', ['x'], true)), false);
	assertEquals(qualifies(makeAttrSite('foo', ['foo'], true)), false);
});

Deno.test("rejects still-unsupported kinds (e.g. for-iterable)", () => {
	const node: ForTNode = { type: 'for', iterable: interpretBackcode('items'), valName: 'item', tnodes: [] };
	const site: BackcodeSite = {
		site: { kind: 'for-iterable', node },
		parsed: interpretBackcode('items'),
		liveVars: ['items'], inForLoop: false,
	};
	assertEquals(qualifies(site), false);
});

Deno.test("accepts attr sites", () => {
	assertEquals(qualifies(makeAttrSite('foo', ['foo'])), true);
});

Deno.test("accepts attr sites with multiple vars", () => {
	assertEquals(qualifies(makeAttrSite('foo + bar', ['foo', 'bar'])), true);
});

Deno.test("accepts definition-root-attr sites", () => {
	const attr: AttrPart = { type: 'dynamic', name: 'class', expr: interpretBackcode('foo'), isBoolean: false };
	const site: BackcodeSite = {
		site: { kind: 'definition-root-attr', attr: attr as any },
		parsed: interpretBackcode('foo'),
		liveVars: ['foo'], inForLoop: false,
	};
	assertEquals(qualifies(site), true);
});

Deno.test("rejects an asset-bearing caller attr (the browser has no asset map)", () => {
	const attr: AttrPart = {
		type: 'dynamic', name: 'src', expr: interpretBackcode('foo'), isBoolean: false, isAsset: true,
	};
	const ref: PartialRefTNode = {
		type: 'partial-ref', kind: 'custom-element', file: null, partialName: 'child-el',
		slots: {}, bindings: [], callerAttrs: [attr],
	};
	const site: BackcodeSite = {
		site: { kind: 'caller-attr-expr', ref: ref as any, attr: attr as any },
		parsed: attr.expr, liveVars: ['foo'], inForLoop: false,
	};
	assertEquals(qualifies(site), false);
	assertEquals(qualifies({ ...site, site: { ...site.site, attr: { ...attr, isAsset: false } } } as BackcodeSite), true);
});

Deno.test("composes with Array.prototype.filter for the standard use", () => {
	const ok = makeAttrSite('foo', ['foo']);
	const inFor = makeAttrSite('foo', ['foo'], true);
	const noVars = makeAttrSite(`'static'`, []);
	const filtered = [ok, inFor, noVars].filter(qualifies);
	assertEquals(filtered.length, 1);
	assertEquals(filtered[0], ok);
});

// --- if-sets ---------------------------------------------------------------
//
// An if-set qualifies only when its whole subtree can be re-rendered in the
// browser. Each test below flips exactly one rule.

function ifSet(branches: IfBranch[], flags: Partial<IfSetSite> = {}): IfSetSite {
	const node: IfTNode = { type: 'if', branches };
	const liveVars: string[] = [];
	for (const br of branches) {
		for (const v of br.condition?.vars ?? []) if (!liveVars.includes(v)) liveVars.push(v);
	}
	return {
		kind: 'if-set', node, container: [node], parentElement: null,
		liveVars, inForLoop: false, ...flags,
	};
}

function branch(cond: string | null, tnodes: TNode[] = []): IfBranch {
	return cond === null ? { tnodes } : { condition: interpretBackcode(cond), tnodes };
}

Deno.test("if-set: a condition with a b-else qualifies", () => {
	assertEquals(qualifies(ifSet([branch('a'), branch(null)])), true);
});

Deno.test("if-set: a condition with no variables disqualifies", () => {
	assertEquals(qualifies(ifSet([branch('a'), branch('1 == 1')])), false);
});

Deno.test("if-set: inside a b-for is skipped", () => {
	assertEquals(qualifies(ifSet([branch('a')], { inForLoop: true })), false);
});

Deno.test("if-set: a set nested inside another set qualifies (nesting allowed)", () => {
	const nested: IfTNode = { type: 'if', branches: [branch('b')] };
	assertEquals(qualifies(ifSet([branch('a', [nested])])), true);
	assertEquals(qualifies(ifSet([branch('b')])), true);
});

Deno.test("if-set: a var-free inner condition leaves the outer set qualifying", () => {
	// `b-if="1 == 1"` names no var — it can't be its own patch site, but it does not
	// disqualify the outer set.
	const nested: IfTNode = { type: 'if', branches: [branch('1 == 1')] };
	assertEquals(qualifies(ifSet([branch('a', [nested])])), true);
});

Deno.test("if-set: a partial ref anywhere in the subtree disqualifies", () => {
	const ref: PartialRefTNode = {
		type: 'partial-ref', kind: 'custom-element', file: null, partialName: 'my-card',
		slots: {}, bindings: [],
	};
	assertEquals(qualifies(ifSet([branch('a', [ref])])), false);
});

Deno.test("if-set: a slot anywhere in the subtree disqualifies", () => {
	const slot: SlotTNode = { type: 'slot', name: undefined };
	assertEquals(qualifies(ifSet([branch('a', [slot])])), false);
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
		assertEquals(qualifies(ifSet([branch('a', [el])])), false);
	}
});

Deno.test("if-set: an unparseable expression in the subtree disqualifies", () => {
	const print: PrintTNode = { type: 'print', data: { expr: undefined, errs: ['bad'], vars: [] } };
	const el: ElementTNode = { type: 'element', tagName: 'p', attrs: [], tnodes: [print] };
	assertEquals(qualifies(ifSet([branch('a', [el])])), false);
});

Deno.test("if-set: a nested b-for qualifies, body and all", () => {
	const print: PrintTNode = { type: 'print', data: interpretBackcode('item.label') };
	const li: ElementTNode = { type: 'element', tagName: 'li', attrs: [], tnodes: [print] };
	const forNode: ForTNode = {
		type: 'for', iterable: interpretBackcode('items'), valName: 'item', tnodes: [li],
	};
	assertEquals(qualifies(ifSet([branch('a', [forNode])])), true);
});

Deno.test("if-set: a nested b-if qualifies", () => {
	const nested: IfTNode = { type: 'if', branches: [branch('b'), branch(null)] };
	assertEquals(qualifies(ifSet([branch('a', [nested])])), true);
});
