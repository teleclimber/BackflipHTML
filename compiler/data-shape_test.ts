import { assertEquals } from "jsr:@std/assert";
import { inferFreeVars } from './data-shape.ts';
import type { RootTNode, TNode, ForTNode, IfTNode, PrintTNode, AttrBindTNode, PartialRefTNode, SlotTNode, RawTNode, ParentTNode } from './compiler.ts';

// Helper to create a Parsed object with given vars
function parsed(vars: string[]) {
	return { expr: undefined, errs: [], vars };
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
