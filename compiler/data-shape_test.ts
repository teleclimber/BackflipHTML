import { assertEquals } from "jsr:@std/assert";
import { inferFreeVars, inferDataShape, validateBAttrUsage, type DataShape } from './data-shape.ts';
import { interpretBackcode } from './backcode.ts';
import type { RootTNode, CustomElementPartialRoot, TNode, ForTNode, IfTNode, PrintTNode, ElementTNode, PartialRefTNode, SlotTNode, RawTNode, ParentTNode } from './types.ts';
import type { Parsed } from './backcode.ts';

// Helper to create a Parsed object with given vars (no AST — for inferFreeVars tests)
function parsed(vars: string[]) {
	return { expr: undefined, errs: [], vars };
}

// Helper to create a real Parsed with acorn AST (for inferDataShape tests)
function realParsed(code: string): Parsed {
	return interpretBackcode(code);
}

function makeRoot(tnodes: TNode[]): RootTNode {
	const root: RootTNode = { type: 'root', kind: 'named', tnodes: [] };
	root.tnodes = tnodes;
	return root;
}

function asBAttrRoot(root: RootTNode): CustomElementPartialRoot {
	(root as { kind: 'named' | 'custom-element' }).kind = 'custom-element';
	return root as CustomElementPartialRoot;
}

function makePrint(vars: string[]): PrintTNode {
	return { type: 'print', data: parsed(vars) };
}

function makeFor(valName: string | undefined, iterableVars: string[], children: TNode[], indexName?: string): ForTNode {
	return { type: 'for', iterable: parsed(iterableVars), ...(valName ? { valName } : {}), ...(indexName ? { indexName } : {}), tnodes: children };
}

function makeIf(branches: { conditionVars?: string[], children: TNode[] }[]): IfTNode {
	const ifNode: IfTNode = { type: 'if', branches: [] };
	ifNode.branches = branches.map(b => ({
		condition: b.conditionVars ? parsed(b.conditionVars) : undefined,
		tnodes: b.children,
		ifNode,
	}));
	return ifNode;
}

function makeAttrBind(dynamicParts: { name: string, vars: string[] }[]): ElementTNode {
	return {
		type: 'element',
		tagName: 'div',
		attrs: dynamicParts.map(p => ({
			type: 'dynamic' as const,
			name: p.name,
			expr: parsed(p.vars),
			isBoolean: false,
		})),
		tnodes: [],
	};
}

function makePartialRef(bindingVars: { name: string, vars: string[] }[], slotContents?: Record<string, TNode[]>): PartialRefTNode {
	return {
		type: 'partial-ref',
		kind: 'b-part' as const,
		file: null,
		partialName: 'test',
		slots: slotContents ?? { 'default': [] },
		bindings: bindingVars.map(b => ({ kind: 'expr' as const, name: b.name, data: parsed(b.vars) })),
		loc: undefined,
	};
}

Deno.test("inferFreeVars: returns empty for partial with no expressions", () => {
	const root = makeRoot([
		{ type: 'raw', raw: '<p>Hello</p>' } as RawTNode,
	]);
	assertEquals(inferFreeVars(root), []);
});

Deno.test("inferFreeVars: collects vars from print expressions", () => {
	const root = makeRoot([
		makePrint(['title']),
		makePrint(['user']),
	]);
	assertEquals(inferFreeVars(root), ['title', 'user']);
});

Deno.test("inferFreeVars: deduplicates vars", () => {
	const root = makeRoot([
		makePrint(['title']),
		makePrint(['title']),
	]);
	assertEquals(inferFreeVars(root), ['title']);
});

Deno.test("inferFreeVars: returns sorted vars", () => {
	const root = makeRoot([
		makePrint(['zebra']),
		makePrint(['alpha']),
	]);
	assertEquals(inferFreeVars(root), ['alpha', 'zebra']);
});

Deno.test("inferFreeVars: excludes b-for loop variable from free vars", () => {
	const root = makeRoot([
		makeFor('item', ['items'], [
			makePrint(['item']),
		]),
	]);
	assertEquals(inferFreeVars(root), ['items']);
});

Deno.test("inferFreeVars: excludes b-for index variable from free vars", () => {
	const root = makeRoot([
		makeFor('item', ['items'], [
			makePrint(['i']),
		], 'i'),
	]);
	assertEquals(inferFreeVars(root), ['items']);
});

Deno.test("inferFreeVars: b-for index variable is scoped to the loop body only", () => {
	const root = makeRoot([
		makeFor('item', ['items'], [], 'i'),
		makePrint(['i']),
	]);
	assertEquals(inferFreeVars(root), ['i', 'items']);
});

Deno.test("inferFreeVars: a loop with no value name scopes only the index; `_` stays free", () => {
	const root = makeRoot([
		makeFor(undefined, ['widgets'], [
			makePrint(['i']),
			makePrint(['_']),
		], 'i'),
	]);
	assertEquals(inferFreeVars(root), ['_', 'widgets']);
});

Deno.test("inferFreeVars: collects iterable var from b-for", () => {
	const root = makeRoot([
		makeFor('item', ['data'], [
			makePrint(['item']),
		]),
	]);
	assertEquals(inferFreeVars(root), ['data']);
});

Deno.test("inferFreeVars: handles nested b-for with both loop vars excluded", () => {
	const root = makeRoot([
		makeFor('group', ['groups'], [
			makeFor('item', ['group'], [
				makePrint(['item']),
			]),
		]),
	]);
	// 'groups' is free; 'group' is scoped by outer for; 'item' is scoped by inner for
	assertEquals(inferFreeVars(root), ['groups']);
});

Deno.test("inferFreeVars: collects vars from b-if conditions", () => {
	const root = makeRoot([
		makeIf([
			{ conditionVars: ['isVisible'], children: [makePrint(['title'])] },
		]),
	]);
	assertEquals(inferFreeVars(root), ['isVisible', 'title']);
});

Deno.test("inferFreeVars: collects vars from b-else-if and b-else branches", () => {
	const root = makeRoot([
		makeIf([
			{ conditionVars: ['condA'], children: [makePrint(['valA'])] },
			{ conditionVars: ['condB'], children: [makePrint(['valB'])] },
			{ conditionVars: undefined, children: [makePrint(['valC'])] },
		]),
	]);
	assertEquals(inferFreeVars(root), ['condA', 'condB', 'valA', 'valB', 'valC']);
});

Deno.test("inferFreeVars: collects vars from b-bind expressions", () => {
	const root = makeRoot([
		makeAttrBind([
			{ name: 'href', vars: ['url'] },
			{ name: 'class', vars: ['className'] },
		]),
	]);
	assertEquals(inferFreeVars(root), ['className', 'url']);
});

Deno.test("inferFreeVars: collects vars from b-data expressions on partial refs", () => {
	const root = makeRoot([
		makePartialRef([
			{ name: 'title', vars: ['pageTitle'] },
			{ name: 'items', vars: ['allItems'] },
		]),
	]);
	assertEquals(inferFreeVars(root), ['allItems', 'pageTitle']);
});

Deno.test("inferFreeVars: collects vars from slot contents in partial refs", () => {
	const root = makeRoot([
		makePartialRef([], {
			'default': [makePrint(['slotVar'])],
		}),
	]);
	assertEquals(inferFreeVars(root), ['slotVar']);
});

Deno.test("inferFreeVars: does not collect vars from slot placeholders", () => {
	const root = makeRoot([
		{ type: 'slot', name: 'header' } as SlotTNode,
	]);
	assertEquals(inferFreeVars(root), []);
});

Deno.test("inferFreeVars: handles complex nesting: b-for inside b-if with attr-bind", () => {
	const root = makeRoot([
		makeIf([
			{
				conditionVars: ['showList'],
				children: [
					makeFor('item', ['items'], [
						makeAttrBind([{ name: 'class', vars: ['item'] }]),
						makePrint(['item']),
						makePrint(['globalLabel']),
					]),
				],
			},
		]),
	]);
	// showList: free (if condition)
	// items: free (for iterable)
	// item: scoped by b-for
	// globalLabel: free
	assertEquals(inferFreeVars(root), ['globalLabel', 'items', 'showList']);
});

// ===================================================================
// inferDataShape tests — use realParsed() to get acorn ASTs
// ===================================================================

// Helpers for shape tests that use real parsed expressions
function makePrintReal(code: string): PrintTNode {
	return { type: 'print', data: realParsed(code) };
}

function makeForReal(valName: string | undefined, iterableCode: string, children: TNode[], indexName?: string): ForTNode {
	return { type: 'for', iterable: realParsed(iterableCode), ...(valName ? { valName } : {}), ...(indexName ? { indexName } : {}), tnodes: children };
}

function makeIfReal(branches: { conditionCode?: string, children: TNode[] }[]): IfTNode {
	const ifNode: IfTNode = { type: 'if', branches: [] };
	ifNode.branches = branches.map(b => ({
		condition: b.conditionCode ? realParsed(b.conditionCode) : undefined,
		tnodes: b.children,
		ifNode,
	}));
	return ifNode;
}

function makeAttrBindReal(parts: { name: string, code: string }[]): ElementTNode {
	return {
		type: 'element',
		tagName: 'div',
		attrs: parts.map(p => ({
			type: 'dynamic' as const,
			name: p.name,
			expr: realParsed(p.code),
			isBoolean: false,
		})),
		tnodes: [],
	};
}

function makePartialRefReal(partialName: string, bindings: { name: string, code: string }[], slotContents?: Record<string, TNode[]>): PartialRefTNode {
	return {
		type: 'partial-ref',
		kind: 'b-part' as const,
		file: null,
		partialName,
		slots: slotContents ?? { 'default': [] },
		bindings: bindings.map(b => ({ kind: 'expr' as const, name: b.name, data: realParsed(b.code) })),
		loc: undefined,
	};
}

function assertUsages(shape: DataShape, expected: string[]) {
	assertEquals([...shape.usages].sort(), expected.sort());
}

// --- Basic usages ---

Deno.test("inferDataShape: printed usage from {{ name }}", () => {
	const root = makeRoot([makePrintReal('name')]);
	const shapes = inferDataShape(root);
	assertEquals(shapes.size, 1);
	const s = shapes.get('name')!;
	assertUsages(s, ['printed']);
});

Deno.test("inferDataShape: attribute usage from :href", () => {
	const root = makeRoot([makeAttrBindReal([{ name: 'href', code: 'url' }])]);
	const shapes = inferDataShape(root);
	const s = shapes.get('url')!;
	assertUsages(s, ['attribute']);
	assertEquals([...s.attributes!], ['href']);
});

Deno.test("inferDataShape: boolean usage from b-if", () => {
	const root = makeRoot([makeIfReal([
		{ conditionCode: 'visible', children: [] },
	])]);
	const shapes = inferDataShape(root);
	const s = shapes.get('visible')!;
	assertUsages(s, ['boolean']);
});

Deno.test("inferDataShape: boolean usage from ! operator", () => {
	const root = makeRoot([makePrintReal('!hidden')]);
	const shapes = inferDataShape(root);
	const s = shapes.get('hidden')!;
	assertUsages(s, ['boolean']);
});

Deno.test("inferDataShape: ternary test is boolean, branches inherit context", () => {
	const root = makeRoot([makePrintReal('show ? a : b')]);
	const shapes = inferDataShape(root);
	assertUsages(shapes.get('show')!, ['boolean']);
	assertUsages(shapes.get('a')!, ['printed']);
	assertUsages(shapes.get('b')!, ['printed']);
});

Deno.test("inferDataShape: equality in b-if records both operands as boolean", () => {
	const root = makeRoot([makeIfReal([
		{ conditionCode: 'a == b', children: [] },
	])]);
	const shapes = inferDataShape(root);
	assertUsages(shapes.get('a')!, ['boolean']);
	assertUsages(shapes.get('b')!, ['boolean']);
});

Deno.test("inferDataShape: equality in print records both operands as printed", () => {
	const root = makeRoot([makePrintReal('a != b')]);
	const shapes = inferDataShape(root);
	assertUsages(shapes.get('a')!, ['printed']);
	assertUsages(shapes.get('b')!, ['printed']);
});

Deno.test("inferDataShape: equality with member access builds property shapes", () => {
	const root = makeRoot([makeIfReal([
		{ conditionCode: 'user.role == "admin"', children: [] },
	])]);
	const shapes = inferDataShape(root);
	const user = shapes.get('user')!;
	const role = user.properties!.get('role')!;
	assertUsages(role, ['boolean']);
});

Deno.test("inferDataShape: ternary in attribute records attribute name on branches", () => {
	const root = makeRoot([makeAttrBindReal([{ name: 'href', code: 'isExternal ? extUrl : intUrl' }])]);
	const shapes = inferDataShape(root);
	assertUsages(shapes.get('isExternal')!, ['boolean']);
	const ext = shapes.get('extUrl')!;
	assertUsages(ext, ['attribute']);
	assertEquals([...ext.attributes!], ['href']);
	const int = shapes.get('intUrl')!;
	assertUsages(int, ['attribute']);
	assertEquals([...int.attributes!], ['href']);
});

// --- Logical operators ---

Deno.test("inferDataShape: the left operand of && and || is a boolean and can be the result", () => {
	for (const code of ['a && b', 'a || b']) {
		const shapes = inferDataShape(makeRoot([makePrintReal(code)]));
		assertUsages(shapes.get('a')!, ['boolean', 'printed']);
		assertUsages(shapes.get('b')!, ['printed']);
	}
});

Deno.test("inferDataShape: && in b-if records both operands as boolean", () => {
	const shapes = inferDataShape(makeRoot([makeIfReal([{ conditionCode: 'a && b.ok', children: [] }])]));
	assertUsages(shapes.get('a')!, ['boolean']);
	assertUsages(shapes.get('b')!.properties!.get('ok')!, ['boolean']);
});

Deno.test("inferDataShape: || in an attribute records the attribute name on both operands", () => {
	const shapes = inferDataShape(makeRoot([makeAttrBindReal([{ name: 'title', code: "label || fallback" }])]));
	assertUsages(shapes.get('label')!, ['attribute', 'boolean']);
	assertEquals([...shapes.get('label')!.attributes!], ['title']);
	assertUsages(shapes.get('fallback')!, ['attribute']);
	assertEquals([...shapes.get('fallback')!.attributes!], ['title']);
});

Deno.test("inferDataShape: || passed to a partial records passedTo on both operands", () => {
	const shapes = inferDataShape(makeRoot([makePartialRefReal('card', [{ name: 'title', code: 'a || b' }])]));
	assertUsages(shapes.get('a')!, ['boolean', 'passed']);
	assertEquals(shapes.get('a')!.passedTo, [{ partial: 'card', as: 'title' }]);
	assertUsages(shapes.get('b')!, ['passed']);
	assertEquals(shapes.get('b')!.passedTo, [{ partial: 'card', as: 'title' }]);
});

Deno.test("inferDataShape: member of a logical expression applies the property shape to both operands", () => {
	const shapes = inferDataShape(makeRoot([makePrintReal('(u && u.profile).name')]));
	const u = shapes.get('u')!;
	assertUsages(u, ['boolean']);
	assertUsages(u.properties!.get('name')!, ['printed']);
	assertUsages(u.properties!.get('profile')!.properties!.get('name')!, ['printed']);
});

Deno.test("inferDataShape: b-for over || puts elementShape on both operands", () => {
	const shapes = inferDataShape(makeRoot([
		makeForReal('x', 'items || fallback', [makePrintReal('x.name')]),
	]));
	assertUsages(shapes.get('items')!, ['boolean', 'iterable']);
	assertUsages(shapes.get('items')!.elementShape!.properties!.get('name')!, ['printed']);
	assertUsages(shapes.get('fallback')!.elementShape!.properties!.get('name')!, ['printed']);
});

Deno.test("inferDataShape: strict equality and arithmetic operands take the surrounding context", () => {
	const printed = inferDataShape(makeRoot([makePrintReal('a * b - c / d % e')]));
	for (const v of ['a', 'b', 'c', 'd', 'e']) assertUsages(printed.get(v)!, ['printed']);
	const cond = inferDataShape(makeRoot([makeIfReal([{ conditionCode: 'a === b', children: [] }])]));
	assertUsages(cond.get('a')!, ['boolean']);
	assertUsages(cond.get('b')!, ['boolean']);
});

// --- Member access on an expression that is not a path ---

Deno.test("inferFreeVars: finds variables in the object of a member access that is not a path", () => {
	for (const [code, vars] of [
		['(a ? b : c).name', ['a', 'b', 'c']],
		['(a + b).length', ['a', 'b']],
		['(!a).x', ['a']],
		['(a ? b : c)[i]', ['a', 'b', 'c', 'i']],
		['((p ? a : b).c ? d : e).f', ['a', 'b', 'd', 'e', 'p']],
	] as const) {
		assertEquals(inferFreeVars(makeRoot([makePrintReal(code)])), [...vars], code);
	}
});

Deno.test("inferDataShape: member of a ternary applies the property shape to both branches", () => {
	const shapes = inferDataShape(makeRoot([makePrintReal('(show ? a : b).name')]));
	assertUsages(shapes.get('show')!, ['boolean']);
	assertUsages(shapes.get('a')!, []);
	assertUsages(shapes.get('a')!.properties!.get('name')!, ['printed']);
	assertUsages(shapes.get('b')!.properties!.get('name')!, ['printed']);
});

Deno.test("inferDataShape: index into a ternary marks both branches indexed", () => {
	const shapes = inferDataShape(makeRoot([makePrintReal('(show ? a : b)[i]')]));
	assertUsages(shapes.get('show')!, ['boolean']);
	assertEquals(shapes.get('a')!.indexed, true);
	assertEquals(shapes.get('a')!.indexVars, ['i']);
	assertEquals(shapes.get('b')!.indexed, true);
	assertUsages(shapes.get('i')!, ['printed']);
});

Deno.test("inferDataShape: nested ternaries in member objects resolve to their branch paths", () => {
	const shapes = inferDataShape(makeRoot([makePrintReal('((p ? a : b).c ? d : e).f')]));
	assertUsages(shapes.get('p')!, ['boolean']);
	assertUsages(shapes.get('a')!.properties!.get('c')!, ['boolean']);
	assertUsages(shapes.get('b')!.properties!.get('c')!, ['boolean']);
	assertUsages(shapes.get('d')!.properties!.get('f')!, ['printed']);
	assertUsages(shapes.get('e')!.properties!.get('f')!, ['printed']);
});

Deno.test("inferDataShape: member of a computed value records its operands in the surrounding context", () => {
	const printed = inferDataShape(makeRoot([makePrintReal('(a + b).length')]));
	assertUsages(printed.get('a')!, ['printed']);
	assertUsages(printed.get('b')!, ['printed']);
	assertEquals(printed.get('a')!.properties, undefined);

	const attr = inferDataShape(makeRoot([makeAttrBindReal([{ name: 'title', code: '(a + b).length' }])]));
	assertUsages(attr.get('a')!, ['attribute']);
	assertEquals([...attr.get('a')!.attributes!], ['title']);

	const negated = inferDataShape(makeRoot([makePrintReal('(!a).x')]));
	assertUsages(negated.get('a')!, ['boolean']);
	assertEquals(negated.get('a')!.properties, undefined);
});

Deno.test("inferDataShape: member of a literal records nothing", () => {
	assertEquals(inferDataShape(makeRoot([makePrintReal('"abc".length')])).size, 0);
});

Deno.test("inferDataShape: b-for over a member of a ternary puts elementShape on each branch path", () => {
	const shapes = inferDataShape(makeRoot([
		makeForReal('x', '(flag ? a : b).list', [makePrintReal('x.name')]),
	]));
	assertUsages(shapes.get('flag')!, ['boolean']);
	for (const name of ['a', 'b']) {
		const list = shapes.get(name)!.properties!.get('list')!;
		assertUsages(list, ['iterable']);
		assertUsages(list.elementShape!.properties!.get('name')!, ['printed']);
	}
});

Deno.test("inferDataShape: iterable usage from b-for", () => {
	const root = makeRoot([makeForReal('item', 'items', [])]);
	const shapes = inferDataShape(root);
	const s = shapes.get('items')!;
	assertUsages(s, ['iterable']);
});

// --- Property access ---

Deno.test("inferDataShape: member access creates properties", () => {
	const root = makeRoot([makePrintReal('user.name')]);
	const shapes = inferDataShape(root);
	const s = shapes.get('user')!;
	assertEquals(s.usages.size, 0); // user itself has no direct usage
	assertEquals(s.properties!.size, 1);
	assertUsages(s.properties!.get('name')!, ['printed']);
});

Deno.test("inferDataShape: nested member access", () => {
	const root = makeRoot([makePrintReal('user.address.city')]);
	const shapes = inferDataShape(root);
	const s = shapes.get('user')!;
	const addr = s.properties!.get('address')!;
	assertEquals(addr.usages.size, 0);
	assertUsages(addr.properties!.get('city')!, ['printed']);
});

Deno.test("inferDataShape: attribute on property records attribute name", () => {
	const root = makeRoot([makeAttrBindReal([{ name: 'class', code: 'item.className' }])]);
	const shapes = inferDataShape(root);
	const s = shapes.get('item')!;
	const cls = s.properties!.get('className')!;
	assertUsages(cls, ['attribute']);
	assertEquals([...cls.attributes!], ['class']);
});

Deno.test("inferDataShape: merges properties from multiple expressions", () => {
	const root = makeRoot([
		makePrintReal('user.name'),
		makePrintReal('user.email'),
	]);
	const shapes = inferDataShape(root);
	const s = shapes.get('user')!;
	assertEquals(s.properties!.size, 2);
	assertUsages(s.properties!.get('name')!, ['printed']);
	assertUsages(s.properties!.get('email')!, ['printed']);
});

// --- Array element shape ---

Deno.test("inferDataShape: b-for body infers elementShape", () => {
	const root = makeRoot([
		makeForReal('item', 'items', [
			makePrintReal('item.name'),
		]),
	]);
	const shapes = inferDataShape(root);
	const s = shapes.get('items')!;
	assertUsages(s, ['iterable']);
	assertEquals(s.elementShape!.properties!.size, 1);
	assertUsages(s.elementShape!.properties!.get('name')!, ['printed']);
});

Deno.test("inferDataShape: b-for with no loop var usage has no elementShape", () => {
	const root = makeRoot([makeForReal('item', 'items', [
		makePrintReal('globalVar'),
	])]);
	const shapes = inferDataShape(root);
	const s = shapes.get('items')!;
	assertUsages(s, ['iterable']);
	assertEquals(s.elementShape, undefined);
	// globalVar is still collected
	assertUsages(shapes.get('globalVar')!, ['printed']);
});

Deno.test("inferDataShape: b-for loop var used directly in print", () => {
	const root = makeRoot([
		makeForReal('item', 'items', [
			makePrintReal('item'),
		]),
	]);
	const shapes = inferDataShape(root);
	const s = shapes.get('items')!;
	assertUsages(s, ['iterable']);
	assertUsages(s.elementShape!, ['printed']);
});

Deno.test("inferDataShape: b-for over a member path puts elementShape on that path", () => {
	const root = makeRoot([
		makeForReal('m', 'meters.data', [makePrintReal('m.index')]),
	]);
	const s = inferDataShape(root).get('meters')!;
	assertEquals(s.elementShape, undefined);
	const data = s.properties!.get('data')!;
	assertUsages(data, ['iterable']);
	assertUsages(data.elementShape!.properties!.get('index')!, ['printed']);
});

Deno.test("inferDataShape: b-for over a deep member path puts elementShape on the leaf", () => {
	const root = makeRoot([
		makeForReal('c', 'a.b.c', [makePrintReal('c.name')]),
	]);
	const a = inferDataShape(root).get('a')!;
	const b = a.properties!.get('b')!;
	const c = b.properties!.get('c')!;
	assertEquals(a.elementShape, undefined);
	assertEquals(b.elementShape, undefined);
	assertUsages(c, ['iterable']);
	assertUsages(c.elementShape!.properties!.get('name')!, ['printed']);
});

Deno.test("inferDataShape: b-for over an indexed path puts elementShape on the indexed entry", () => {
	const root = makeRoot([
		makeForReal('r', 'rows[k]', [makePrintReal('r.name')]),
	]);
	const shapes = inferDataShape(root);
	const rows = shapes.get('rows')!;
	assertEquals(rows.indexed, true);
	assertEquals(rows.indexVars, ['k']);
	assertUsages(rows, ['iterable']);
	assertUsages(rows.elementShape!.properties!.get('name')!, ['printed']);
	assertEquals(shapes.has('k'), true);
	assertEquals(shapes.get('k')!.elementShape, undefined);
});

Deno.test("inferDataShape: nested b-for over a member of the outer loop var", () => {
	const root = makeRoot([
		makeForReal('group', 'groups', [
			makeForReal('item', 'group.items', [makePrintReal('item.name')]),
		]),
	]);
	const groups = inferDataShape(root).get('groups')!;
	const group = groups.elementShape!;
	assertEquals(group.elementShape, undefined);
	const items = group.properties!.get('items')!;
	assertUsages(items, ['iterable']);
	assertUsages(items.elementShape!.properties!.get('name')!, ['printed']);
});

Deno.test("inferDataShape: b-for over a ternary puts elementShape on the branches, not the test", () => {
	const root = makeRoot([
		makeForReal('x', 'flag ? a.list : b', [makePrintReal('x.name')]),
	]);
	const shapes = inferDataShape(root);
	assertEquals(shapes.get('flag')!.elementShape, undefined);
	assertEquals(shapes.get('a')!.elementShape, undefined);
	const list = shapes.get('a')!.properties!.get('list')!;
	assertUsages(list.elementShape!.properties!.get('name')!, ['printed']);
	assertUsages(shapes.get('b')!.elementShape!.properties!.get('name')!, ['printed']);
});

// --- Passed to partial ---

Deno.test("inferDataShape: passed usage from b-data binding", () => {
	const root = makeRoot([
		makePartialRefReal('card', [{ name: 'title', code: 'pageTitle' }]),
	]);
	const shapes = inferDataShape(root);
	const s = shapes.get('pageTitle')!;
	assertUsages(s, ['passed']);
	assertEquals(s.passedTo!, [{ partial: 'card', as: 'title' }]);
});

Deno.test("inferDataShape: passed with member access", () => {
	const root = makeRoot([
		makePartialRefReal('card', [{ name: 'title', code: 'post.title' }]),
	]);
	const shapes = inferDataShape(root);
	const s = shapes.get('post')!;
	assertEquals(s.usages.size, 0);
	const titleProp = s.properties!.get('title')!;
	assertUsages(titleProp, ['passed']);
	assertEquals(titleProp.passedTo!, [{ partial: 'card', as: 'title' }]);
});

// --- Multiple usages on same variable ---

Deno.test("inferDataShape: multiple usages combined", () => {
	const root = makeRoot([
		makeIfReal([{ conditionCode: 'items', children: [] }]),
		makeForReal('item', 'items', []),
	]);
	const shapes = inferDataShape(root);
	const s = shapes.get('items')!;
	assertUsages(s, ['boolean', 'iterable']);
});

Deno.test("inferDataShape: printed + attribute combined", () => {
	const root = makeRoot([
		makePrintReal('x'),
		makeAttrBindReal([{ name: 'class', code: 'x' }]),
	]);
	const shapes = inferDataShape(root);
	const s = shapes.get('x')!;
	assertUsages(s, ['printed', 'attribute']);
	assertEquals([...s.attributes!], ['class']);
});

Deno.test("inferDataShape: multiple attributes collected", () => {
	const root = makeRoot([
		makeAttrBindReal([
			{ name: 'href', code: 'x' },
			{ name: 'class', code: 'x' },
		]),
	]);
	const shapes = inferDataShape(root);
	const s = shapes.get('x')!;
	assertUsages(s, ['attribute']);
	assertEquals([...s.attributes!].sort(), ['class', 'href']);
});

// --- Scoping ---

Deno.test("inferDataShape: loop variable excluded from result", () => {
	const root = makeRoot([
		makeForReal('item', 'items', [
			makePrintReal('item'),
		]),
	]);
	const shapes = inferDataShape(root);
	assertEquals(shapes.has('item'), false);
	assertEquals(shapes.has('items'), true);
});

Deno.test("inferDataShape: index variable excluded from result and from elementShape", () => {
	const root = makeRoot([
		makeForReal('item', 'items', [
			makePrintReal('i'),
			makePrintReal('item.name'),
		], 'i'),
	]);
	const shapes = inferDataShape(root);
	assertEquals([...shapes.keys()], ['items']);
	assertEquals([...shapes.get('items')!.elementShape!.properties!.keys()], ['name']);
});

Deno.test("inferDataShape: a loop with no value name records no elementShape", () => {
	const root = makeRoot([
		makeForReal(undefined, 'widgets', [makePrintReal('i')], 'i'),
	]);
	const shapes = inferDataShape(root);
	assertEquals([...shapes.keys()], ['widgets']);
	assertEquals(shapes.get('widgets')!.elementShape, undefined);
});

Deno.test("inferDataShape: nested for scoping", () => {
	const root = makeRoot([
		makeForReal('group', 'groups', [
			makeForReal('item', 'group', [
				makePrintReal('item'),
			]),
		]),
	]);
	const shapes = inferDataShape(root);
	assertEquals(shapes.has('item'), false);
	assertEquals(shapes.has('group'), false);
	assertEquals(shapes.has('groups'), true);
});

// --- Edge cases ---

Deno.test("inferDataShape: static partial returns empty map", () => {
	const root = makeRoot([
		{ type: 'raw', raw: '<p>Hello</p>' } as RawTNode,
	]);
	const shapes = inferDataShape(root);
	assertEquals(shapes.size, 0);
});

Deno.test("inferDataShape: computed member sets indexed flag", () => {
	const root = makeRoot([makePrintReal('items[idx]')]);
	const shapes = inferDataShape(root);
	const s = shapes.get('items')!;
	assertUsages(s, ['printed']);
	assertEquals(s.indexed, true);
	assertUsages(shapes.get('idx')!, ['printed']);
});

Deno.test("inferDataShape: an index variable inside a property chain is a free variable", () => {
	for (const code of ['items[idx].name', 'store.data[idx].name', 'store.data[idx]', 'a.b[idx].c.d', 'a[b.c[idx].d]']) {
		const shapes = inferDataShape(makeRoot([makePrintReal(code)]));
		assertEquals(shapes.has('idx'), true, `${code}: ${[...shapes.keys()]}`);
	}
});

Deno.test("inferDataShape: an index variable inside a property chain in an attribute is a free variable", () => {
	const el: ElementTNode = {
		type: 'element', tagName: 'a', tnodes: [],
		attrs: [{ type: 'dynamic', name: 'title', expr: realParsed('m.list[k].label'), isBoolean: false }],
	};
	const shapes = inferDataShape(makeRoot([el]));
	assertUsages(shapes.get('k')!, ['printed']);
});

Deno.test("inferDataShape: an index is used as a key, whatever the expression's context", () => {
	const ifNode: IfTNode = { type: 'if', branches: [{ condition: realParsed('m[a] ? n.x[b].y : o[c]'), tnodes: [] }] };
	const shapes = inferDataShape(makeRoot([ifNode]));
	for (const v of ['a', 'b', 'c']) assertUsages(shapes.get(v)!, ['printed']);
	assertEquals(shapes.get('m')!.usages.has('boolean'), true);
});

Deno.test("inferDataShape: an indexed shape records the variable it is indexed by", () => {
	const shapes = inferDataShape(makeRoot([makePrintReal('items[idx]'), makePrintReal('widgets.data[widget_id].name')]));
	assertEquals(shapes.get('items')!.indexVars, ['idx']);
	assertEquals(shapes.get('widgets')!.properties!.get('data')!.indexVars, ['widget_id']);
});

Deno.test("inferDataShape: index variables merge across uses", () => {
	const shapes = inferDataShape(makeRoot([makePrintReal('m[a].x'), makePrintReal('m[b].y'), makePrintReal('m[a].z')]));
	assertEquals(shapes.get('m')!.indexVars, ['a', 'b']);
});

Deno.test("inferDataShape: a literal, a loop variable or an expression index records no index variable", () => {
	const shapes = inferDataShape(makeRoot([
		makePrintReal('lit[0].name'),
		makePrintReal('expr[a + b]'),
		makeForReal('i', 'ids', [makePrintReal('looped[i].name')]),
	]));
	assertEquals(shapes.get('lit')!.indexVars, undefined);
	assertEquals(shapes.get('expr')!.indexVars, undefined);
	assertEquals(shapes.get('looped')!.indexVars, undefined);
	assertEquals(shapes.get('looped')!.indexed, true);
});

Deno.test("inferDataShape: slot contents tracked in caller scope", () => {
	const root = makeRoot([
		makePartialRefReal('btn', [], {
			'default': [makePrintReal('label')],
		}),
	]);
	const shapes = inferDataShape(root);
	assertUsages(shapes.get('label')!, ['printed']);
});

Deno.test("inferDataShape: b-if condition + body vars tracked separately", () => {
	const root = makeRoot([
		makeIfReal([
			{ conditionCode: 'isVisible', children: [makePrintReal('title')] },
			{ conditionCode: undefined, children: [makePrintReal('fallback')] },
		]),
	]);
	const shapes = inferDataShape(root);
	assertUsages(shapes.get('isVisible')!, ['boolean']);
	assertUsages(shapes.get('title')!, ['printed']);
	assertUsages(shapes.get('fallback')!, ['printed']);
});

// --- b-attr pre-seeding (Stage 3) ---

Deno.test("inferDataShape: pre-seeds b-attr non-bool variable as scalar 'string'", () => {
	const root = makeRoot([makePrintReal('premium')]);
	asBAttrRoot(root).bAttrs =[{ name: 'premium', isBool: false }];
	const shapes = inferDataShape(root);
	const s = shapes.get('premium')!;
	assertEquals(s.scalar, 'string');
	assertUsages(s, ['printed']);
});

Deno.test("inferDataShape: pre-seeds b-attr bool variable as scalar 'bool'", () => {
	const root = makeRoot([makePrintReal('premium')]);
	asBAttrRoot(root).bAttrs =[{ name: 'premium', isBool: true }];
	const shapes = inferDataShape(root);
	const s = shapes.get('premium')!;
	assertEquals(s.scalar, 'bool');
});

Deno.test("inferDataShape: unused b-attr variable still appears in shape map", () => {
	const root = makeRoot([
		{ type: 'raw', raw: '<p>static</p>' } as RawTNode,
	]);
	asBAttrRoot(root).bAttrs =[{ name: 'premium', isBool: true }, { name: 'label', isBool: false }];
	const shapes = inferDataShape(root);
	assertEquals(shapes.has('premium'), true);
	assertEquals(shapes.get('premium')!.scalar, 'bool');
	assertEquals(shapes.get('label')!.scalar, 'string');
});

Deno.test("inferDataShape: pre-seeds multiple b-attrs with mixed bool/string", () => {
	const root = makeRoot([]);
	asBAttrRoot(root).bAttrs =[
		{ name: 'premium', isBool: true },
		{ name: 'label', isBool: false },
		{ name: 'checked', isBool: true },
	];
	const shapes = inferDataShape(root);
	assertEquals(shapes.get('premium')!.scalar, 'bool');
	assertEquals(shapes.get('label')!.scalar, 'string');
	assertEquals(shapes.get('checked')!.scalar, 'bool');
});

// --- validateBAttrUsage tests (Stage 3) ---

Deno.test("validateBAttrUsage: returns no errors for partial without b-attrs", () => {
	const root = makeRoot([makePrintReal('foo')]);
	const errors = validateBAttrUsage(root, 'test.html');
	assertEquals(errors.length, 0);
});

Deno.test("validateBAttrUsage: error when b-attr used as iterable (b-for)", () => {
	const root = makeRoot([
		makeForReal('item', 'items', [makePrintReal('item')]),
	]);
	asBAttrRoot(root).bAttrs =[{ name: 'items', isBool: false }];
	const errors = validateBAttrUsage(root, 'test.html');
	assertEquals(errors.length, 1);
	assertEquals(errors[0].severity, 'fatal');
	assertEquals(errors[0].message.includes('items'), true);
	assertEquals(errors[0].message.includes('object/array/iterable'), true);
});

Deno.test("validateBAttrUsage: error when b-attr used as object (member access)", () => {
	const root = makeRoot([makePrintReal('user.name')]);
	asBAttrRoot(root).bAttrs =[{ name: 'user', isBool: false }];
	const errors = validateBAttrUsage(root, 'test.html');
	assertEquals(errors.length, 1);
	assertEquals(errors[0].message.includes('user'), true);
});

Deno.test("validateBAttrUsage: error when b-attr is indexed", () => {
	const root = makeRoot([makePrintReal('items[0]')]);
	asBAttrRoot(root).bAttrs =[{ name: 'items', isBool: false }];
	const errors = validateBAttrUsage(root, 'test.html');
	assertEquals(errors.length, 1);
});

Deno.test("validateBAttrUsage: warning when bool b-attr is printed", () => {
	const root = makeRoot([makePrintReal('premium')]);
	asBAttrRoot(root).bAttrs =[{ name: 'premium', isBool: true }];
	const errors = validateBAttrUsage(root, 'test.html');
	assertEquals(errors.length, 1);
	assertEquals(errors[0].severity, 'warning');
	assertEquals(errors[0].message.includes('premium'), true);
});

Deno.test("validateBAttrUsage: no warning when string b-attr is printed", () => {
	const root = makeRoot([makePrintReal('label')]);
	asBAttrRoot(root).bAttrs =[{ name: 'label', isBool: false }];
	const errors = validateBAttrUsage(root, 'test.html');
	assertEquals(errors.length, 0);
});

Deno.test("validateBAttrUsage: no warning when string b-attr is used as boolean", () => {
	const root = makeRoot([
		makeIfReal([{ conditionCode: 'premium', children: [] }]),
	]);
	asBAttrRoot(root).bAttrs =[{ name: 'premium', isBool: false }];
	const errors = validateBAttrUsage(root, 'test.html');
	assertEquals(errors.length, 0);
});

Deno.test("validateBAttrUsage: no warning when bool b-attr is used as boolean (correct usage)", () => {
	const root = makeRoot([
		makeIfReal([{ conditionCode: 'premium', children: [] }]),
	]);
	asBAttrRoot(root).bAttrs =[{ name: 'premium', isBool: true }];
	const errors = validateBAttrUsage(root, 'test.html');
	assertEquals(errors.length, 0);
});

Deno.test("validateBAttrUsage: no error/warning when b-attr passed to sub-partial", () => {
	const root = makeRoot([
		makePartialRefReal('card', [{ name: 'title', code: 'label' }]),
	]);
	asBAttrRoot(root).bAttrs =[{ name: 'label', isBool: false }];
	const errors = validateBAttrUsage(root, 'test.html');
	assertEquals(errors.length, 0);
});

Deno.test("validateBAttrUsage: no warning when bool b-attr is used in attribute binding", () => {
	const root = makeRoot([
		makeAttrBindReal([{ name: 'title', code: 'premium' }]),
	]);
	asBAttrRoot(root).bAttrs =[{ name: 'premium', isBool: true }];
	const errors = validateBAttrUsage(root, 'test.html');
	// Only 'attribute' usage (not 'printed'), so no warning per spec.
	assertEquals(errors.length, 0);
});

Deno.test("validateBAttrUsage: error includes filename in loc", () => {
	const root = makeRoot([makePrintReal('user.name')]);
	asBAttrRoot(root).bAttrs =[{ name: 'user', isBool: false }];
	const errors = validateBAttrUsage(root, 'pages/index.html');
	assertEquals(errors.length, 1);
	assertEquals(errors[0].filename, 'pages/index.html');
});

// --- definition-tag attributes are part of the partial's data shape ----------
//
// `definitionAttrs` render in the child context, so the variables they name are
// data the partial needs, exactly like one used in the body.

Deno.test("inferDataShape: a variable used only in a definition attr is in the shape", () => {
	const root = asBAttrRoot(makeRoot([]));
	root.definitionAttrs = [
		{ type: 'dynamic', name: 'data-x', expr: realParsed('other'), isBoolean: false },
	];
	const shapes = inferDataShape(root);
	assertEquals(shapes.has('other'), true);
});

Deno.test("inferDataShape: a static definition attr contributes no variable", () => {
	const root = asBAttrRoot(makeRoot([]));
	root.definitionAttrs = [{ type: 'static', raw: ' class="card"' }];
	assertEquals([...inferDataShape(root).keys()], []);
});

Deno.test("inferDataShape: a definition attr records an attribute usage", () => {
	const root = asBAttrRoot(makeRoot([]));
	root.definitionAttrs = [
		{ type: 'dynamic', name: 'data-x', expr: realParsed('other'), isBoolean: false },
	];
	assertEquals(inferDataShape(root).get('other')!.usages.has('attribute'), true);
});
