import { assertEquals } from "jsr:@std/assert";
import { inferFreeVars, inferDataShape, type DataShape } from './data-shape.ts';
import { interpretBackcode } from './backcode.ts';
import type { RootTNode, TNode, ForTNode, IfTNode, PrintTNode, AttrBindTNode, PartialRefTNode, SlotTNode, RawTNode, ParentTNode } from './compiler.ts';
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
	const root: RootTNode = { type: 'root', tnodes: [] };
	root.tnodes = tnodes;
	return root;
}

function makePrint(vars: string[]): PrintTNode {
	return { type: 'print', data: parsed(vars), parent: {} as ParentTNode };
}

function makeFor(valName: string, iterableVars: string[], children: TNode[]): ForTNode {
	return { type: 'for', iterable: parsed(iterableVars), valName, tnodes: children, parent: {} as ParentTNode };
}

function makeIf(branches: { conditionVars?: string[], children: TNode[] }[]): IfTNode {
	const ifNode: IfTNode = { type: 'if', branches: [], parent: {} as ParentTNode };
	ifNode.branches = branches.map(b => ({
		condition: b.conditionVars ? parsed(b.conditionVars) : undefined,
		tnodes: b.children,
		ifNode,
	}));
	return ifNode;
}

function makeAttrBind(dynamicParts: { name: string, vars: string[] }[]): AttrBindTNode {
	return {
		type: 'attr-bind',
		tagOpen: '<div',
		parts: dynamicParts.map(p => ({
			type: 'dynamic' as const,
			name: p.name,
			expr: parsed(p.vars),
			isBoolean: false,
		})),
		parent: {} as ParentTNode,
	};
}

function makePartialRef(bindingVars: { name: string, vars: string[] }[], slotContents?: Record<string, TNode[]>): PartialRefTNode {
	return {
		type: 'partial-ref',
		file: null,
		partialName: 'test',
		wrapper: null,
		slots: slotContents ?? { 'default': [] },
		bindings: bindingVars.map(b => ({ name: b.name, data: parsed(b.vars) })),
		parent: {} as ParentTNode,
		loc: undefined,
	};
}

Deno.test("inferFreeVars: returns empty for partial with no expressions", () => {
	const root = makeRoot([
		{ type: 'raw', raw: '<p>Hello</p>', parent: {} as ParentTNode } as RawTNode,
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
		{ type: 'slot', name: 'header', parent: {} as ParentTNode } as SlotTNode,
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
	return { type: 'print', data: realParsed(code), parent: {} as ParentTNode };
}

function makeForReal(valName: string, iterableCode: string, children: TNode[]): ForTNode {
	return { type: 'for', iterable: realParsed(iterableCode), valName, tnodes: children, parent: {} as ParentTNode };
}

function makeIfReal(branches: { conditionCode?: string, children: TNode[] }[]): IfTNode {
	const ifNode: IfTNode = { type: 'if', branches: [], parent: {} as ParentTNode };
	ifNode.branches = branches.map(b => ({
		condition: b.conditionCode ? realParsed(b.conditionCode) : undefined,
		tnodes: b.children,
		ifNode,
	}));
	return ifNode;
}

function makeAttrBindReal(parts: { name: string, code: string }[]): AttrBindTNode {
	return {
		type: 'attr-bind',
		tagOpen: '<div',
		parts: parts.map(p => ({
			type: 'dynamic' as const,
			name: p.name,
			expr: realParsed(p.code),
			isBoolean: false,
		})),
		parent: {} as ParentTNode,
	};
}

function makePartialRefReal(partialName: string, bindings: { name: string, code: string }[], slotContents?: Record<string, TNode[]>): PartialRefTNode {
	return {
		type: 'partial-ref',
		file: null,
		partialName,
		wrapper: null,
		slots: slotContents ?? { 'default': [] },
		bindings: bindings.map(b => ({ name: b.name, data: realParsed(b.code) })),
		parent: {} as ParentTNode,
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
		{ type: 'raw', raw: '<p>Hello</p>', parent: {} as ParentTNode } as RawTNode,
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
