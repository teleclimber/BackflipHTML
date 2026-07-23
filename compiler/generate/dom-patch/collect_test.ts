import { assertEquals } from "jsr:@std/assert";

import type {
	CustomElementPartialRoot, ElementTNode, PrintTNode, ForTNode, IfTNode,
	IfBranch, AttrPart,
} from "../../types.ts";
import { interpretBackcode } from "../../backcode.ts";
import { collectPatchTree, type BranchScope, type Site } from "./collect.ts";
import { qualifies } from "./filter.ts";

// Collect with the production predicate, so the tree reflects real qualification.
function tree(root: CustomElementPartialRoot, live: string[]): BranchScope {
	const set = new Set(live);
	return collectPatchTree(root, set, (s: Site) => qualifies(s, set));
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

Deno.test("root scope: refElement is null, sites collected, no sets", () => {
	const el = elem('div', [dyn('title', 'foo'), dyn('class', 'bar')]);
	const scope = tree(root(el), ['foo', 'bar']);
	assertEquals(scope.refElement, null);
	assertEquals(scope.sets.length, 0);
	assertEquals(scope.sites.length, 2);
	assertEquals(scope.sites[0].site.kind, 'attr');
	assertEquals(scope.sites[0].liveVars, ['foo']);
	assertEquals(scope.sites[1].liveVars, ['bar']);
});

Deno.test("non-qualifying sites are dropped (mixed live/non-live)", () => {
	const el = elem('div', [dyn('title', 'foo + other')]);
	const scope = tree(root(el), ['foo']);
	assertEquals(scope.sites.length, 0);
	assertEquals(scope.sets.length, 0);
});

Deno.test("collects print nodes", () => {
	const p: PrintTNode = { type: 'print', data: interpretBackcode('user') };
	const scope = tree(root(p), ['user']);
	assertEquals(scope.sites.length, 1);
	assertEquals(scope.sites[0].site.kind, 'print');
	assertEquals(scope.sites[0].liveVars, ['user']);
});

Deno.test("print site carries its container and nearest enclosing element", () => {
	// Print directly in the root → parentElement is null (the custom element itself).
	const rootPrint: PrintTNode = { type: 'print', data: interpretBackcode('a') };
	const r1 = root(rootPrint);
	const s1 = tree(r1, ['a']).sites[0];
	if (s1.site.kind !== 'print') throw new Error('expected print');
	assertEquals(s1.site.parentElement, null);
	assertEquals(s1.site.container, r1.tnodes);

	// Print inside a <p> → parentElement is that <p>, container is the <p>'s children.
	const bodyPrint: PrintTNode = { type: 'print', data: interpretBackcode('b') };
	const p = elem('p', [], [bodyPrint]);
	const s2 = tree(root(p), ['b']).sites[0];
	if (s2.site.kind !== 'print') throw new Error('expected print');
	assertEquals(s2.site.parentElement, p);
	assertEquals(s2.site.container, p.tnodes);
});

Deno.test("a qualifying if-set becomes a set with per-branch child scopes", () => {
	const innerEl = elem('span', [dyn('title', 'x')]);
	const branch1: IfBranch = { condition: interpretBackcode('show'), tnodes: [innerEl] };
	const branch2: IfBranch = { condition: undefined, tnodes: [] };
	const ifNode: IfTNode = { type: 'if', branches: [branch1, branch2] };
	const scope = tree(root(ifNode), ['show', 'x']);

	// The set is owned by the root scope; no loose sites in the root.
	assertEquals(scope.sites.length, 0);
	assertEquals(scope.sets.length, 1);
	assertEquals(scope.sets[0].set.node, ifNode);
	assertEquals(scope.sets[0].set.inForLoop, false);

	// One child scope per branch, ref element = the set's nearest enclosing element.
	assertEquals(scope.sets[0].branches.length, 2);
	const [child0, child1] = scope.sets[0].branches;
	assertEquals(child0.refElement, null);
	assertEquals(child0.sites.length, 1);
	assertEquals(child0.sites[0].site.kind, 'attr');
	assertEquals(child1.sites.length, 0);
});

Deno.test("child scope refElement is the set's parent element", () => {
	const innerEl = elem('span', [dyn('title', 'x')]);
	const ifNode: IfTNode = { type: 'if', branches: [{ condition: interpretBackcode('show'), tnodes: [innerEl] }] };
	const wrapper = elem('div', [], [ifNode]);
	const scope = tree(root(wrapper), ['show', 'x']);
	assertEquals(scope.sets[0].set.parentElement, wrapper);
	assertEquals(scope.sets[0].branches[0].refElement, wrapper);
});

Deno.test("if-set trigger vars are the union of its own branch conditions only", () => {
	// Nested condition var `deep` must not become a trigger var of the outer set.
	const nested: IfTNode = { type: 'if', branches: [{ condition: interpretBackcode('deep'), tnodes: [] }] };
	const ifNode: IfTNode = {
		type: 'if',
		branches: [
			{ condition: interpretBackcode('a'), tnodes: [nested] },
			{ condition: interpretBackcode('b'), tnodes: [] },
			{ condition: undefined, tnodes: [] },
		],
	};
	const scope = tree(root(ifNode), ['a', 'b', 'deep']);
	assertEquals(scope.sets[0].set.liveVars, ['a', 'b']);
});

Deno.test("a nested qualifying if-set becomes a set inside the child scope", () => {
	const nested: IfTNode = { type: 'if', branches: [{ condition: interpretBackcode('b'), tnodes: [] }] };
	const outer: IfTNode = { type: 'if', branches: [{ condition: interpretBackcode('a'), tnodes: [nested] }] };
	const scope = tree(root(outer), ['a', 'b']);
	assertEquals(scope.sets.length, 1);
	assertEquals(scope.sets[0].set.node, outer);
	const child = scope.sets[0].branches[0];
	assertEquals(child.sets.length, 1);
	assertEquals(child.sets[0].set.node, nested);
});

Deno.test("a non-qualifying nested set is walked inline (no child boundary)", () => {
	// `b-if="1 == 1"` names no var, so it doesn't qualify; its content stays in the
	// enclosing (root) scope rather than becoming its own patch-branch.
	const print: PrintTNode = { type: 'print', data: interpretBackcode('x') };
	const inert: IfTNode = { type: 'if', branches: [{ condition: interpretBackcode('1 == 1'), tnodes: [print] }] };
	const scope = tree(root(inert), ['x']);
	assertEquals(scope.sets.length, 0);
	assertEquals(scope.sites.length, 1);
	assertEquals(scope.sites[0].site.kind, 'print');
});

Deno.test("sites inside a b-for are not collected (v1 limitation)", () => {
	const innerEl = elem('li', [dyn('title', 'x')]);
	const forNode: ForTNode = {
		type: 'for', iterable: interpretBackcode('items'), valName: 'item', tnodes: [innerEl],
	};
	const scope = tree(root(forNode), ['items', 'x']);
	assertEquals(scope.sites.length, 0);
	assertEquals(scope.sets.length, 0);
});

Deno.test("an if-set inside a b-for does not become a set (inForLoop disqualifies)", () => {
	const ifNode: IfTNode = { type: 'if', branches: [{ condition: interpretBackcode('a'), tnodes: [] }] };
	const forNode: ForTNode = {
		type: 'for', iterable: interpretBackcode('items'), valName: 'item', tnodes: [ifNode],
	};
	const scope = tree(root(forNode), ['a', 'items']);
	assertEquals(scope.sets.length, 0);
});

Deno.test("collects dynamic attrs on the definition's wrapping tag (definition-root-attr)", () => {
	const r: CustomElementPartialRoot = {
		type: 'root', kind: 'custom-element',
		tnodes: [],
		definitionAttrs: [
			dyn('class', `flag ? 'yes' : 'no'`),
			dyn('hidden', 'flag', true),
		],
	};
	const scope = tree(r, ['flag']);
	assertEquals(scope.sites.length, 2);
	assertEquals(scope.sites[0].site.kind, 'definition-root-attr');
	assertEquals(scope.sites[0].liveVars, ['flag']);
	assertEquals(scope.sites[1].site.kind, 'definition-root-attr');
});

Deno.test("element body content is traversed", () => {
	const inner = elem('span', [dyn('title', 'foo')]);
	const outer = elem('div', [], [inner]);
	const scope = tree(root(outer), ['foo']);
	assertEquals(scope.sites.length, 1);
	assertEquals(scope.sites[0].site.kind, 'attr');
});
