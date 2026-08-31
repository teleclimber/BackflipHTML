import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { generateSlotPlaceholders } from './slot-placeholders.ts';
import type { TNode, RootTNode } from '../compiler/types.ts';

/** Helper: create a minimal parent for ChildTNodes. */
function dummyRoot(): RootTNode {
	return { type: 'root', kind: 'named', tnodes: [], exported: false };
}

/** Create a slot TNode. */
function slotNode(name?: string): TNode {
	return { type: 'slot', name } as TNode;
}

/** Create a raw TNode. */
function rawNode(raw: string): TNode {
	return { type: 'raw', raw } as TNode;
}

/** Create an element TNode wrapping the given children — used to model a `<head>` boundary. */
function elementNode(tagName: string, children: TNode[]): TNode {
	return { type: 'element', tagName, attrs: [], tnodes: children } as TNode;
}

Deno.test("generates placeholder for default slot", () => {
	const slotMap = generateSlotPlaceholders([slotNode()]);
	assertEquals('default' in slotMap, true);
	assertEquals(slotMap.default.nodes.length, 1);
	const raw = slotMap.default.nodes[0];
	assertEquals(raw.type, 'raw');
	assertStringIncludes((raw as any).raw, 'default content');
});

Deno.test("generates placeholder for named slot", () => {
	const slotMap = generateSlotPlaceholders([slotNode('header')]);
	assertEquals('header' in slotMap, true);
	const raw = slotMap.header.nodes[0];
	assertStringIncludes((raw as any).raw, 'slot: header');
});

Deno.test("generates multiple slots", () => {
	const slotMap = generateSlotPlaceholders([slotNode(), slotNode('header'), slotNode('footer')]);
	assertEquals(Object.keys(slotMap).length, 3);
	assertStringIncludes((slotMap.default.nodes[0] as any).raw, 'default content');
	assertStringIncludes((slotMap.header.nodes[0] as any).raw, 'slot: header');
	assertStringIncludes((slotMap.footer.nodes[0] as any).raw, 'slot: footer');
});

Deno.test("slot placeholder has empty context", () => {
	const slotMap = generateSlotPlaceholders([slotNode()]);
	assertEquals(slotMap.default.ctx, {});
});

Deno.test("empty tnodes returns empty map", () => {
	const slotMap = generateSlotPlaceholders([]);
	assertEquals(Object.keys(slotMap).length, 0);
});

Deno.test("placeholder HTML has dashed border styling", () => {
	const slotMap = generateSlotPlaceholders([slotNode()]);
	const raw = (slotMap.default.nodes[0] as any).raw;
	assertStringIncludes(raw, 'border:1px dashed');
	assertStringIncludes(raw, 'background:#e0e0e0');
});

Deno.test("slot inside <head> raw tnode gets empty nodes", () => {
	const tnodes: TNode[] = [
		rawNode('<head>'),
		slotNode('head-slot'),
		rawNode('</head>'),
	];
	const slotMap = generateSlotPlaceholders(tnodes);
	assertEquals(slotMap['head-slot'].nodes.length, 0);
});

Deno.test("slot after </head> gets placeholder", () => {
	const tnodes: TNode[] = [
		rawNode('<head>'),
		slotNode('head-slot'),
		rawNode('</head>'),
		slotNode('body-slot'),
	];
	const slotMap = generateSlotPlaceholders(tnodes);
	assertEquals(slotMap['head-slot'].nodes.length, 0);
	assertEquals(slotMap['body-slot'].nodes.length, 1);
	assertStringIncludes((slotMap['body-slot'].nodes[0] as any).raw, 'slot: body-slot');
});

Deno.test("slot inside <head> ElementTNode gets empty nodes", () => {
	const tnodes: TNode[] = [
		elementNode('head', [slotNode('meta')]),
	];
	const slotMap = generateSlotPlaceholders(tnodes);
	assertEquals(slotMap.meta.nodes.length, 0);
});

Deno.test("slot outside head is not affected by a sibling head ElementTNode", () => {
	const tnodes: TNode[] = [
		elementNode('head', [slotNode('meta')]),
		slotNode('content'),
	];
	const slotMap = generateSlotPlaceholders(tnodes);
	assertEquals(slotMap.meta.nodes.length, 0);
	assertEquals(slotMap.content.nodes.length, 1);
});

Deno.test("generates placeholder for a slot forwarded into a call body", () => {
	// <div b-part="#child"><b-unwrap b-in="inner" b-slot="outer"/></div>
	// "outer" is a slot of the partial being previewed, so it needs a placeholder.
	const tnodes: TNode[] = [
		{ type: 'partial-ref', kind: 'b-part', file: null, partialName: 'child', bindings: [],
			slots: { default: [], inner: [slotNode('outer')] } } as TNode,
	];
	const slotMap = generateSlotPlaceholders(tnodes);
	assertEquals('outer' in slotMap, true);
	assertStringIncludes((slotMap.outer.nodes[0] as any).raw, 'slot: outer');
});
