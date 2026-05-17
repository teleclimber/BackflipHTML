import { assertEquals } from "jsr:@std/assert";

import type {
	RootTNode, TNode, RawTNode, ElementTNode, ForTNode, IfTNode,
	PrintTNode, PartialRefTNode, AttrBindTNode, AttrPart,
} from "./types.ts";
import { interpretBackcode } from "./backcode.ts";
import { flattenStatics } from "./flatten.ts";

// ---- builders for terse tree construction ----

function root(tnodes: TNode[]): RootTNode {
	return { type: 'root', kind: 'named', tnodes };
}

function el(tagName: string, attrs: AttrPart[], tnodes: TNode[], extra: Partial<ElementTNode> = {}): ElementTNode {
	return { type: 'element', tagName, attrs, tnodes, ...extra };
}

function staticAttr(raw: string): AttrPart {
	return { type: 'static', raw };
}

function dynamicAttr(name: string, expr: string): AttrPart {
	return { type: 'dynamic', name, expr: interpretBackcode(expr), isBoolean: false };
}

function raw(s: string): RawTNode {
	return { type: 'raw', raw: s };
}

function print(expr: string): PrintTNode {
	return { type: 'print', data: interpretBackcode(expr) };
}

// ---- tests ----

Deno.test("flatten: fully-static element becomes a single raw", () => {
	const tree = root([
		el('div', [staticAttr(' class="foo"')], [raw('hello')]),
	]);
	const out = flattenStatics(tree);
	assertEquals(out.tnodes.length, 1);
	assertEquals(out.tnodes[0], { type: 'raw', raw: '<div class="foo">hello</div>' });
});

Deno.test("flatten: element with dynamic attr decomposes around an AttrBindTNode", () => {
	const tree = root([
		el('div', [staticAttr(' '), dynamicAttr('class', 'cls')], [raw('hello')]),
	]);
	const out = flattenStatics(tree);
	assertEquals(out.tnodes.length, 3);
	assertEquals(out.tnodes[0], { type: 'raw', raw: '<div' });
	assertEquals(out.tnodes[1].type, 'attr-bind');
	const ab = out.tnodes[1] as AttrBindTNode;
	assertEquals(ab.attrs.length, 2);
	assertEquals(ab.attrs[0], { type: 'static', raw: ' ' });
	assertEquals(ab.attrs[1].type, 'dynamic');
	assertEquals(out.tnodes[2], { type: 'raw', raw: '>hello</div>' });
});

Deno.test("flatten: dynamic attr deep in a static wrapper still flattens outer raws", () => {
	// <div><p :class="cls">blahs</p></div>
	const tree = root([
		el('div', [], [
			el('p', [dynamicAttr('class', 'cls')], [raw('blahs')]),
		]),
	]);
	const out = flattenStatics(tree);
	assertEquals(out.tnodes.length, 3);
	assertEquals(out.tnodes[0], { type: 'raw', raw: '<div><p' });
	assertEquals(out.tnodes[1].type, 'attr-bind');
	assertEquals((out.tnodes[1] as AttrBindTNode).attrs.length, 1);
	assertEquals((out.tnodes[1] as AttrBindTNode).attrs[0].type, 'dynamic');
	assertEquals(out.tnodes[2], { type: 'raw', raw: '>blahs</p></div>' });
});

Deno.test("flatten: dynamic attr on self-closing element uses ' />' closer", () => {
	const tree = root([
		el('input', [dynamicAttr('value', 'v')], [], { isVoid: true, selfClosing: true }),
	]);
	const out = flattenStatics(tree);
	assertEquals(out.tnodes.length, 3);
	assertEquals(out.tnodes[0], { type: 'raw', raw: '<input' });
	assertEquals(out.tnodes[1].type, 'attr-bind');
	assertEquals(out.tnodes[2], { type: 'raw', raw: ' />' });
});

Deno.test("flatten: dynamic attr on void element uses '>' closer and no end tag", () => {
	const tree = root([
		el('img', [dynamicAttr('src', 's')], [], { isVoid: true }),
	]);
	const out = flattenStatics(tree);
	assertEquals(out.tnodes.length, 3);
	assertEquals(out.tnodes[0], { type: 'raw', raw: '<img' });
	assertEquals(out.tnodes[1].type, 'attr-bind');
	assertEquals(out.tnodes[2], { type: 'raw', raw: '>' });
});

Deno.test("flatten: element with dynamic attr and dynamic child stays an element", () => {
	// Children include a print, so the element isn't leaf-flat — keep as ElementTNode.
	const tree = root([
		el('div', [dynamicAttr('class', 'cls')], [print('name')]),
	]);
	const out = flattenStatics(tree);
	assertEquals(out.tnodes.length, 1);
	assertEquals(out.tnodes[0].type, 'element');
});

Deno.test("flatten: AttrBindTNode passes through unchanged on a second pass", () => {
	const tree = root([
		el('div', [dynamicAttr('class', 'cls')], [raw('hi')]),
	]);
	const once = flattenStatics(tree);
	const twice = flattenStatics(once);
	assertEquals(twice, once);
});

Deno.test("flatten: element with dynamic child is kept as an element", () => {
	const tree = root([
		el('div', [], [print('name')]),
	]);
	const out = flattenStatics(tree);
	assertEquals(out.tnodes.length, 1);
	assertEquals(out.tnodes[0].type, 'element');
	const div = out.tnodes[0] as ElementTNode;
	// Child is a PrintTNode, preserved as-is.
	assertEquals(div.tnodes.length, 1);
	assertEquals(div.tnodes[0].type, 'print');
});

Deno.test("flatten: nested fully-static elements collapse to one raw", () => {
	const tree = root([
		el('div', [staticAttr(' class="outer"')], [
			el('span', [staticAttr(' class="inner"')], [raw('hi')]),
		]),
	]);
	const out = flattenStatics(tree);
	assertEquals(out.tnodes.length, 1);
	assertEquals(out.tnodes[0], {
		type: 'raw',
		raw: '<div class="outer"><span class="inner">hi</span></div>',
	});
});

Deno.test("flatten: mixed static outer / dynamic inner — inner static elements still flattened", () => {
	const tree = root([
		el('div', [], [
			el('header', [staticAttr(' id="h"')], [raw('Title')]),
			print('name'),
			el('footer', [staticAttr(' id="f"')], [raw('Bye')]),
		]),
	]);
	const out = flattenStatics(tree);
	const div = out.tnodes[0] as ElementTNode;
	assertEquals(div.type, 'element');
	assertEquals(div.tnodes.length, 3);
	assertEquals(div.tnodes[0], { type: 'raw', raw: '<header id="h">Title</header>' });
	assertEquals(div.tnodes[1].type, 'print');
	assertEquals(div.tnodes[2], { type: 'raw', raw: '<footer id="f">Bye</footer>' });
});

Deno.test("flatten: adjacent raws after flattening are merged", () => {
	const tree = root([
		raw('<a>'),
		el('b', [], [raw('bold')]),
		raw('</a>'),
	]);
	const out = flattenStatics(tree);
	assertEquals(out.tnodes.length, 1);
	assertEquals(out.tnodes[0], { type: 'raw', raw: '<a><b>bold</b></a>' });
});

Deno.test("flatten: for-loop with all-static body — body flattened, for preserved", () => {
	const tree = root([
		{
			type: 'for',
			iterable: interpretBackcode('items'),
			valName: 'item',
			tnodes: [
				el('li', [staticAttr(' class="row"')], [raw('static')]),
			],
		} as ForTNode,
	]);
	const out = flattenStatics(tree);
	assertEquals(out.tnodes.length, 1);
	assertEquals(out.tnodes[0].type, 'for');
	const f = out.tnodes[0] as ForTNode;
	assertEquals(f.tnodes.length, 1);
	assertEquals(f.tnodes[0], { type: 'raw', raw: '<li class="row">static</li>' });
});

Deno.test("flatten: if-branch contents are flattened", () => {
	const tree = root([
		{
			type: 'if',
			branches: [
				{
					condition: interpretBackcode('x'),
					tnodes: [
						raw('<a>'),
						el('b', [], [raw('B')]),
						raw('</a>'),
					],
				},
				{
					tnodes: [
						el('span', [], [raw('default')]),
					],
				},
			],
		} as IfTNode,
	]);
	const out = flattenStatics(tree);
	const ifNode = out.tnodes[0] as IfTNode;
	assertEquals(ifNode.branches[0].tnodes.length, 1);
	assertEquals(ifNode.branches[0].tnodes[0], { type: 'raw', raw: '<a><b>B</b></a>' });
	assertEquals(ifNode.branches[1].tnodes.length, 1);
	assertEquals(ifNode.branches[1].tnodes[0], { type: 'raw', raw: '<span>default</span>' });
});

Deno.test("flatten: partial-ref slot content is flattened", () => {
	const tree = root([
		{
			type: 'partial-ref',
			kind: 'b-part',
			file: null,
			partialName: 'card',
			slots: {
				default: [
					el('p', [staticAttr(' class="body"')], [raw('content')]),
				],
				title: [
					raw('<h1>'),
					el('span', [], [raw('Title')]),
					raw('</h1>'),
				],
			},
			bindings: [],
		} as PartialRefTNode,
	]);
	const out = flattenStatics(tree);
	const ref = out.tnodes[0] as PartialRefTNode;
	assertEquals(ref.slots.default.length, 1);
	assertEquals(ref.slots.default[0], { type: 'raw', raw: '<p class="body">content</p>' });
	assertEquals(ref.slots.title.length, 1);
	assertEquals(ref.slots.title[0], { type: 'raw', raw: '<h1><span>Title</span></h1>' });
});

Deno.test("flatten: void element flattened without closing tag", () => {
	const tree = root([
		el('div', [], [
			el('br', [], [], { isVoid: true }),
			el('img', [staticAttr(' src="a.png"')], [], { isVoid: true, selfClosing: true }),
		]),
	]);
	const out = flattenStatics(tree);
	assertEquals(out.tnodes.length, 1);
	assertEquals(out.tnodes[0], { type: 'raw', raw: '<div><br><img src="a.png" /></div>' });
});

Deno.test("flatten: idempotent — running twice produces deep-equal result", () => {
	const tree = root([
		el('div', [], [
			el('header', [staticAttr(' id="h"')], [raw('T')]),
			print('name'),
			el('footer', [staticAttr(' id="f"')], [raw('B')]),
		]),
		{
			type: 'for',
			iterable: interpretBackcode('xs'),
			valName: 'x',
			tnodes: [el('li', [], [raw('item')])],
		} as ForTNode,
	]);
	const once = flattenStatics(tree);
	const twice = flattenStatics(once);
	assertEquals(twice, once);
});

Deno.test("flatten: element with asset attr is not flattened (asset stays unresolved)", () => {
	const assetAttr: AttrPart = {
		type: 'asset',
		attrName: 'src',
		originalValue: '@img/foo.png',
		refs: [{ name: 'img', subpath: 'foo.png' }],
	};
	const tree = root([
		el('img', [assetAttr], [], { isVoid: true }),
	]);
	const out = flattenStatics(tree);
	assertEquals(out.tnodes.length, 1);
	assertEquals(out.tnodes[0].type, 'element');
});

Deno.test("flatten: preserves RootTNode kind and metadata", () => {
	const tree: RootTNode = {
		type: 'root',
		kind: 'custom-element',
		tnodes: [el('div', [], [raw('hi')])],
		definitionAttrNames: ['a', 'b'],
		definitionAttrs: [staticAttr(' a="1"')],
	};
	const out = flattenStatics(tree);
	assertEquals(out.kind, 'custom-element');
	assertEquals(out.tnodes.length, 1);
	assertEquals(out.tnodes[0], { type: 'raw', raw: '<div>hi</div>' });
	// Round-trip: other fields preserved.
	if (out.kind === 'custom-element') {
		assertEquals(out.definitionAttrNames, ['a', 'b']);
		assertEquals(out.definitionAttrs?.length, 1);
	}
});

Deno.test("flatten: input tree is not mutated", () => {
	const inner = el('span', [], [raw('hi')]);
	const outer = el('div', [], [inner]);
	const tree = root([outer]);
	const before = JSON.parse(JSON.stringify(tree));
	flattenStatics(tree);
	assertEquals(tree, before);
});

Deno.test("flatten: empty root yields empty root", () => {
	const tree = root([]);
	const out = flattenStatics(tree);
	assertEquals(out.tnodes, []);
});

Deno.test("flatten: slot node passes through unchanged", () => {
	const tree = root([
		el('div', [], [
			{ type: 'slot', name: undefined },
		]),
	]);
	const out = flattenStatics(tree);
	// Element has a slot child — slot is not raw, so element is not flattened.
	const div = out.tnodes[0] as ElementTNode;
	assertEquals(div.type, 'element');
	assertEquals(div.tnodes[0].type, 'slot');
});
