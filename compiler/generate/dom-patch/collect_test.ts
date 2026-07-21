import { assertEquals } from "jsr:@std/assert";

import type {
	CustomElementPartialRoot, ElementTNode, PrintTNode, ForTNode, IfTNode,
	IfBranch, AttrPart, CustomElementCallTNode,
} from "../../types.ts";
import { interpretBackcode } from "../../backcode.ts";
import { collectBackcodeSites, isIfSetSite, type BackcodeSite, type Site } from "./collect.ts";

// Most tests here are about single-expression sites; drop if-sets so indexes stay stable.
function backcodeSites(sites: Site[]): BackcodeSite[] {
	return sites.filter((s): s is BackcodeSite => !isIfSetSite(s));
}

function dyn(name: string, code: string, isBoolean = false): AttrPart {
	return { type: 'dynamic', name, expr: interpretBackcode(code), isBoolean };
}

function elem(tagName: string, attrs: AttrPart[], tnodes: any[] = []): ElementTNode {
	return { type: 'element', tagName, attrs, tnodes };
}

function root(...tnodes: any[]): CustomElementPartialRoot {
	return { type: 'root', kind: 'custom-element', tnodes };
}

Deno.test("collects dynamic attr sites with live vars", () => {
	const el = elem('div', [dyn('title', 'foo'), dyn('class', 'bar + baz')]);
	const r = root(el);
	const sites = backcodeSites(collectBackcodeSites(r, new Set(['foo', 'baz'])));
	assertEquals(sites.length, 2);
	assertEquals(sites[0].site.kind, 'attr');
	assertEquals(sites[0].liveVars, ['foo']);
	assertEquals(sites[0].otherVars, []);
	assertEquals(sites[1].liveVars, ['baz']);
	assertEquals(sites[1].otherVars, ['bar']);
});

Deno.test("collects print nodes", () => {
	const p: PrintTNode = { type: 'print', data: interpretBackcode('user.name') };
	const r = root(p);
	const sites = backcodeSites(collectBackcodeSites(r, new Set(['user'])));
	assertEquals(sites.length, 1);
	assertEquals(sites[0].site.kind, 'print');
	assertEquals(sites[0].liveVars, ['user']);
});

Deno.test("print site carries its container and nearest enclosing element", () => {
	// Print directly in the root → parentElement is null (the custom element itself).
	const rootPrint: PrintTNode = { type: 'print', data: interpretBackcode('a') };
	const r1 = root(rootPrint);
	const s1 = backcodeSites(collectBackcodeSites(r1, new Set(['a'])))[0];
	if (s1.site.kind !== 'print') throw new Error('expected print');
	assertEquals(s1.site.parentElement, null);
	assertEquals(s1.site.container, r1.tnodes);

	// Print inside a <p> → parentElement is that <p>, container is the <p>'s children.
	const bodyPrint: PrintTNode = { type: 'print', data: interpretBackcode('b') };
	const p = elem('p', [], [bodyPrint]);
	const r2 = root(p);
	const s2 = backcodeSites(collectBackcodeSites(r2, new Set(['b'])))[0];
	if (s2.site.kind !== 'print') throw new Error('expected print');
	assertEquals(s2.site.parentElement, p);
	assertEquals(s2.site.container, p.tnodes);
});

Deno.test("print inside b-if keeps nearest element as parent (if is DOM-transparent)", () => {
	const print: PrintTNode = { type: 'print', data: interpretBackcode('a') };
	const branch: IfBranch = { condition: interpretBackcode('show'), tnodes: [print] };
	const ifNode: IfTNode = { type: 'if', branches: [branch] };
	const p = elem('p', [], [ifNode]);
	const r = root(p);
	const printSite = backcodeSites(collectBackcodeSites(r, new Set(['a', 'show']))).find(s => s.site.kind === 'print')!;
	if (printSite.site.kind !== 'print') throw new Error('expected print');
	assertEquals(printSite.site.parentElement, p);
	// The markers must be inserted as siblings of the print, i.e. inside the branch.
	assertEquals(printSite.site.container, branch.tnodes);
});

Deno.test("collects the whole if-set as one site and still recurses into branches", () => {
	const innerEl = elem('span', [dyn('title', 'x')]);
	const branch1: IfBranch = { condition: interpretBackcode('show'), tnodes: [innerEl] };
	const branch2: IfBranch = { condition: undefined, tnodes: [] };
	const ifNode: IfTNode = { type: 'if', branches: [branch1, branch2] };
	const r = root(ifNode);
	const all = collectBackcodeSites(r, new Set(['show', 'x']));
	// One if-set (not one site per branch) plus the attr site inside the branch.
	const ifSets = all.filter(isIfSetSite);
	assertEquals(ifSets.length, 1);
	assertEquals(ifSets[0].node, ifNode);
	assertEquals(ifSets[0].inIfSet, false);
	assertEquals(ifSets[0].inForLoop, false);
	const bc = backcodeSites(all);
	assertEquals(bc.length, 1);
	assertEquals(bc[0].site.kind, 'attr');
	assertEquals(bc[0].inForLoop, false);
});

Deno.test("if-set trigger vars are the union of its own branch conditions only", () => {
	// Nested condition var `deep` must not become a trigger var of the outer set.
	const nested: IfTNode = { type: 'if', branches: [{ condition: interpretBackcode('deep'), tnodes: [] }] };
	const ifNode: IfTNode = {
		type: 'if',
		branches: [
			{ condition: interpretBackcode('a'), tnodes: [nested] },
			{ condition: interpretBackcode('b + other'), tnodes: [] },
			{ condition: undefined, tnodes: [] },
		],
	};
	const r = root(ifNode);
	const ifSets = collectBackcodeSites(r, new Set(['a', 'b', 'deep'])).filter(isIfSetSite);
	assertEquals(ifSets[0].liveVars, ['a', 'b']);
	assertEquals(ifSets[0].otherVars, ['other']);
});

Deno.test("if-set carries its container and nearest enclosing element", () => {
	// Set directly in the root → parentElement is null (the custom element itself).
	const top: IfTNode = { type: 'if', branches: [{ condition: interpretBackcode('a'), tnodes: [] }] };
	const r1 = root(top);
	const s1 = collectBackcodeSites(r1, new Set(['a'])).filter(isIfSetSite)[0];
	assertEquals(s1.parentElement, null);
	assertEquals(s1.container, r1.tnodes);

	// Set inside a <p> → parentElement is that <p>, container is the <p>'s children.
	const inner: IfTNode = { type: 'if', branches: [{ condition: interpretBackcode('b'), tnodes: [] }] };
	const p = elem('p', [], [inner]);
	const r2 = root(p);
	const s2 = collectBackcodeSites(r2, new Set(['b'])).filter(isIfSetSite)[0];
	assertEquals(s2.parentElement, p);
	assertEquals(s2.container, p.tnodes);
});

Deno.test("a nested if-set is flagged inIfSet; the outer one is not", () => {
	const nested: IfTNode = { type: 'if', branches: [{ condition: interpretBackcode('b'), tnodes: [] }] };
	const outer: IfTNode = { type: 'if', branches: [{ condition: interpretBackcode('a'), tnodes: [nested] }] };
	const r = root(outer);
	const ifSets = collectBackcodeSites(r, new Set(['a', 'b'])).filter(isIfSetSite);
	assertEquals(ifSets.length, 2);
	assertEquals(ifSets[0].node, outer);
	assertEquals(ifSets[0].inIfSet, false);
	assertEquals(ifSets[1].node, nested);
	assertEquals(ifSets[1].inIfSet, true);
});

Deno.test("an if-set inside a b-for is flagged inForLoop", () => {
	const ifNode: IfTNode = { type: 'if', branches: [{ condition: interpretBackcode('a'), tnodes: [] }] };
	const forNode: ForTNode = {
		type: 'for', iterable: interpretBackcode('items'), valName: 'item', tnodes: [ifNode],
	};
	const r = root(forNode);
	const ifSets = collectBackcodeSites(r, new Set(['a', 'items'])).filter(isIfSetSite);
	assertEquals(ifSets.length, 1);
	assertEquals(ifSets[0].inForLoop, true);
});

Deno.test("a b-for nested inside an if-set does not mark the set itself", () => {
	// The for is inside the branch, so descendants are inForLoop but the set is not.
	const el = elem('li', [dyn('title', 'x')]);
	const forNode: ForTNode = {
		type: 'for', iterable: interpretBackcode('items'), valName: 'item', tnodes: [el],
	};
	const ifNode: IfTNode = { type: 'if', branches: [{ condition: interpretBackcode('a'), tnodes: [forNode] }] };
	const r = root(ifNode);
	const all = collectBackcodeSites(r, new Set(['a', 'items', 'x']));
	assertEquals(all.filter(isIfSetSite)[0].inForLoop, false);
	assertEquals(backcodeSites(all).find(s => s.site.kind === 'attr')!.inForLoop, true);
});

Deno.test("for-iterable site and inForLoop flag on descendants", () => {
	const innerEl = elem('li', [dyn('title', 'x')]);
	const forNode: ForTNode = {
		type: 'for',
		iterable: interpretBackcode('items'),
		valName: 'item',
		tnodes: [innerEl],
	};
	const r = root(forNode);
	const sites = backcodeSites(collectBackcodeSites(r, new Set(['items', 'x'])));
	assertEquals(sites.length, 2);
	assertEquals(sites[0].site.kind, 'for-iterable');
	assertEquals(sites[0].inForLoop, false);
	assertEquals(sites[1].site.kind, 'attr');
	assertEquals(sites[1].inForLoop, true);
});

Deno.test("nested for sets inForLoop on grand-descendants too", () => {
	const innerEl = elem('p', [dyn('title', 'foo')]);
	const innerFor: ForTNode = {
		type: 'for', iterable: interpretBackcode('cols'), valName: 'col',
		tnodes: [innerEl],
	};
	const outerFor: ForTNode = {
		type: 'for', iterable: interpretBackcode('rows'), valName: 'row',
		tnodes: [innerFor],
	};
	const r = root(outerFor);
	const sites = backcodeSites(collectBackcodeSites(r, new Set(['rows', 'cols', 'foo'])));
	const attrSite = sites.find(s => s.site.kind === 'attr')!;
	assertEquals(attrSite.inForLoop, true);
});

Deno.test("partial-ref bindings collected; slots not traversed", () => {
	// Slot contains an element with a live var — should NOT be collected.
	const slotEl = elem('div', [dyn('title', 'shouldNotSee')]);
	const ref: CustomElementCallTNode = {
		type: 'partial-ref',
		kind: 'custom-element',
		file: null,
		partialName: 'my-card',
		slots: { default: [slotEl] },
		bindings: [
			{ kind: 'expr', name: 'heading', data: interpretBackcode('title') },
			{ kind: 'literal', name: 'flag', value: true },
		],
	};
	const r = root(ref);
	const sites = backcodeSites(collectBackcodeSites(r, new Set(['title', 'shouldNotSee'])));
	assertEquals(sites.length, 1);
	assertEquals(sites[0].site.kind, 'binding');
	assertEquals(sites[0].liveVars, ['title']);
});

Deno.test("caller-attr-expr sites collected from custom-element ref", () => {
	const ref: CustomElementCallTNode = {
		type: 'partial-ref', kind: 'custom-element',
		file: null, partialName: 'my-card',
		slots: {}, bindings: [],
		callerAttrInfos: [
			{ name: 'data-x', kind: 'expr', value: '', expr: interpretBackcode('foo') },
			{ name: 'class', kind: 'plain', value: 'static' },
		],
	};
	const r = root(ref);
	const sites = backcodeSites(collectBackcodeSites(r, new Set(['foo'])));
	assertEquals(sites.length, 1);
	assertEquals(sites[0].site.kind, 'caller-attr-expr');
	assertEquals(sites[0].liveVars, ['foo']);
});

Deno.test("collects dynamic attrs on definition's wrapping tag (definition-root-attr)", () => {
	const r: CustomElementPartialRoot = {
		type: 'root', kind: 'custom-element',
		tnodes: [],
		definitionAttrs: [
			dyn('class', `flag ? 'yes' : 'no'`),
			dyn('hidden', 'flag', true),
		],
	};
	const sites = backcodeSites(collectBackcodeSites(r, new Set(['flag'])));
	assertEquals(sites.length, 2);
	assertEquals(sites[0].site.kind, 'definition-root-attr');
	assertEquals(sites[0].liveVars, ['flag']);
	assertEquals(sites[0].inForLoop, false);
	assertEquals(sites[1].site.kind, 'definition-root-attr');
});

Deno.test("element body content is traversed", () => {
	const inner = elem('span', [dyn('title', 'foo')]);
	const outer = elem('div', [], [inner]);
	const r = root(outer);
	const sites = backcodeSites(collectBackcodeSites(r, new Set(['foo'])));
	assertEquals(sites.length, 1);
	assertEquals(sites[0].site.kind, 'attr');
});
