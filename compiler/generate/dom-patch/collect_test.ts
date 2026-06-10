import { assertEquals } from "jsr:@std/assert";

import type {
	CustomElementPartialRoot, ElementTNode, PrintTNode, ForTNode, IfTNode,
	IfBranch, AttrPart, CustomElementCallTNode,
} from "../../types.ts";
import { interpretBackcode } from "../../backcode.ts";
import { collectBackcodeSites } from "./collect.ts";

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
	const sites = collectBackcodeSites(r, new Set(['foo', 'baz']));
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
	const sites = collectBackcodeSites(r, new Set(['user']));
	assertEquals(sites.length, 1);
	assertEquals(sites[0].site.kind, 'print');
	assertEquals(sites[0].liveVars, ['user']);
});

Deno.test("print site carries its container and nearest enclosing element", () => {
	// Print directly in the root → parentElement is null (the custom element itself).
	const rootPrint: PrintTNode = { type: 'print', data: interpretBackcode('a') };
	const r1 = root(rootPrint);
	const s1 = collectBackcodeSites(r1, new Set(['a']))[0];
	if (s1.site.kind !== 'print') throw new Error('expected print');
	assertEquals(s1.site.parentElement, null);
	assertEquals(s1.site.container, r1.tnodes);

	// Print inside a <p> → parentElement is that <p>, container is the <p>'s children.
	const bodyPrint: PrintTNode = { type: 'print', data: interpretBackcode('b') };
	const p = elem('p', [], [bodyPrint]);
	const r2 = root(p);
	const s2 = collectBackcodeSites(r2, new Set(['b']))[0];
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
	const printSite = collectBackcodeSites(r, new Set(['a', 'show'])).find(s => s.site.kind === 'print')!;
	if (printSite.site.kind !== 'print') throw new Error('expected print');
	assertEquals(printSite.site.parentElement, p);
	// The markers must be inserted as siblings of the print, i.e. inside the branch.
	assertEquals(printSite.site.container, branch.tnodes);
});

Deno.test("collects if-condition sites and recurses into branches", () => {
	const innerEl = elem('span', [dyn('title', 'x')]);
	const branch1: IfBranch = { condition: interpretBackcode('show'), tnodes: [innerEl] };
	const branch2: IfBranch = { condition: undefined, tnodes: [] };
	const ifNode: IfTNode = { type: 'if', branches: [branch1, branch2] };
	const r = root(ifNode);
	const sites = collectBackcodeSites(r, new Set(['show', 'x']));
	assertEquals(sites.length, 2);
	assertEquals(sites[0].site.kind, 'if-condition');
	assertEquals(sites[1].site.kind, 'attr');
	assertEquals(sites[1].inForLoop, false);
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
	const sites = collectBackcodeSites(r, new Set(['items', 'x']));
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
	const sites = collectBackcodeSites(r, new Set(['rows', 'cols', 'foo']));
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
	const sites = collectBackcodeSites(r, new Set(['title', 'shouldNotSee']));
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
	const sites = collectBackcodeSites(r, new Set(['foo']));
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
	const sites = collectBackcodeSites(r, new Set(['flag']));
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
	const sites = collectBackcodeSites(r, new Set(['foo']));
	assertEquals(sites.length, 1);
	assertEquals(sites[0].site.kind, 'attr');
});
