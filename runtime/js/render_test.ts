import { assertEquals, assertThrows, assertStringIncludes } from "jsr:@std/assert";

import type { RootRNode, RawRNode, PrintRNode, ForRNode, IfRNode, SlotRNode, PartialRefRNode, RNode, rfn } from "./render.ts";
import { render, renderRoot, streamRenderRoot, escapeHtml } from "./render.ts";

function streamToString(n: RootRNode, ctx: any): string {
	return Array.from(streamRenderRoot(n, ctx)).join('');
}

function makeFn(code: string, vars: string[]): rfn {
	return { fn: new Function(...vars, `return ${code};`) as (...args: any[]) => any, vars };
}

Deno.test("raw node", () => {
	assertEquals(render({ type: 'raw', raw: '<p>hello</p>' }, {}), '<p>hello</p>');
});

Deno.test("comment node", () => {
	assertEquals(render({ type: 'comment', text: 'bfid:bf1' }, {}), '<!--bfid:bf1-->');
});

Deno.test("print node", () => {
	const node: PrintRNode = { type: 'print', data: makeFn('name', ['name']) };
	assertEquals(render(node, { name: 'world' }), 'world');
});

Deno.test("for node", () => {
	const node: ForRNode = {
		type: 'for',
		iterable: makeFn('items', ['items']),
		valName: 'item',
		nodes: [
			{ type: 'raw', raw: '<li>' },
			{ type: 'print', data: makeFn('item', ['item']) },
			{ type: 'raw', raw: '</li>' },
		]
	};
	assertEquals(render(node, { items: ['a', 'b'] }), '<li>a</li><li>b</li>');
});

Deno.test("for node with non-iterable throws", () => {
	const node: ForRNode = {
		type: 'for',
		iterable: makeFn('42', []),
		valName: 'item',
		nodes: []
	};
	assertThrows(() => render(node, {}), Error, "iterable not iterable");
});

Deno.test("if node - true condition", () => {
	const node: IfRNode = {
		type: 'if',
		branches: [{
			condition: makeFn('show', ['show']),
			nodes: [{ type: 'raw', raw: 'yes' }]
		}]
	};
	assertEquals(render(node, { show: true }), 'yes');
});

Deno.test("if node - false condition", () => {
	const node: IfRNode = {
		type: 'if',
		branches: [{
			condition: makeFn('show', ['show']),
			nodes: [{ type: 'raw', raw: 'yes' }]
		}]
	};
	assertEquals(render(node, { show: false }), '');
});

Deno.test("if/else - true branch", () => {
	const node: IfRNode = {
		type: 'if',
		branches: [
			{ condition: makeFn('show', ['show']), nodes: [{ type: 'raw', raw: 'yes' }] },
			{ condition: undefined, nodes: [{ type: 'raw', raw: 'no' }] },
		]
	};
	assertEquals(render(node, { show: true }), 'yes');
});

Deno.test("if/else - false branch", () => {
	const node: IfRNode = {
		type: 'if',
		branches: [
			{ condition: makeFn('show', ['show']), nodes: [{ type: 'raw', raw: 'yes' }] },
			{ condition: undefined, nodes: [{ type: 'raw', raw: 'no' }] },
		]
	};
	assertEquals(render(node, { show: false }), 'no');
});

Deno.test("if/else-if/else picks first truthy branch", () => {
	const node: IfRNode = {
		type: 'if',
		branches: [
			{ condition: makeFn('a', ['a']), nodes: [{ type: 'raw', raw: '1' }] },
			{ condition: makeFn('b', ['b']), nodes: [{ type: 'raw', raw: '2' }] },
			{ condition: undefined, nodes: [{ type: 'raw', raw: '3' }] },
		]
	};
	assertEquals(render(node, { a: false, b: true }), '2');
	assertEquals(render(node, { a: true, b: true }), '1');
	assertEquals(render(node, { a: false, b: false }), '3');
});

Deno.test("if branch can contain print nodes", () => {
	const node: IfRNode = {
		type: 'if',
		branches: [{
			condition: makeFn('true', []),
			nodes: [
				{ type: 'raw', raw: 'hello ' },
				{ type: 'print', data: makeFn('name', ['name']) },
			]
		}]
	};
	assertEquals(render(node, { name: 'world' }), 'hello world');
});

Deno.test("for inside if", () => {
	const node: IfRNode = {
		type: 'if',
		branches: [{
			condition: makeFn('show', ['show']),
			nodes: [{
				type: 'for',
				iterable: makeFn('items', ['items']),
				valName: 'item',
				nodes: [{ type: 'print', data: makeFn('item', ['item']) }]
			}]
		}]
	};
	assertEquals(render(node, { show: true, items: ['a', 'b'] }), 'ab');
	assertEquals(render(node, { show: false, items: ['a', 'b'] }), '');
});

Deno.test("if inside for", () => {
	const node: ForRNode = {
		type: 'for',
		iterable: makeFn('items', ['items']),
		valName: 'item',
		nodes: [{
			type: 'if',
			branches: [
				{ condition: makeFn('item.show', ['item']), nodes: [{ type: 'print', data: makeFn('item.name', ['item']) }] },
			]
		}]
	};
	const ctx = { items: [{ name: 'a', show: true }, { name: 'b', show: false }, { name: 'c', show: true }] };
	assertEquals(render(node, ctx), 'ac');
});

Deno.test("renderRoot", () => {
	const root: RootRNode = {
		type: 'root',
		nodes: [
			{ type: 'raw', raw: '<p>' },
			{ type: 'print', data: makeFn('x', ['x']) },
			{ type: 'raw', raw: '</p>' },
		]
	};
	assertEquals(renderRoot(root, { x: 'hi' }), '<p>hi</p>');
});

Deno.test("for node with empty iterable", () => {
	const node: ForRNode = {
		type: 'for',
		iterable: makeFn('items', ['items']),
		valName: 'item',
		nodes: [{ type: 'raw', raw: 'nope' }]
	};
	assertEquals(render(node, { items: [] }), '');
});

Deno.test("for loop context does not leak between iterations", () => {
	const node: ForRNode = {
		type: 'for',
		iterable: makeFn('items', ['items']),
		valName: 'item',
		nodes: [{ type: 'print', data: makeFn('item', ['item']) }]
	};
	assertEquals(render(node, { items: ['x', 'y', 'z'] }), 'xyz');
});

Deno.test("for loop does not mutate outer context", () => {
	const node: ForRNode = {
		type: 'for',
		iterable: makeFn('items', ['items']),
		valName: 'item',
		nodes: [{ type: 'print', data: makeFn('item', ['item']) }]
	};
	const ctx = { items: ['a'], item: 'original' };
	render(node, ctx);
	assertEquals(ctx.item, 'original');
});

// partial-ref and slot tests

const simplePartial = {
	type: 'root' as const,
	nodes: [{ type: 'raw' as const, raw: '<p>hello</p>' }]
};

Deno.test("partial-ref with no slots and no bindings", () => {
	const node: PartialRefRNode = {
		type: 'partial-ref',
		partial: simplePartial,
		wrapper: null,
		slots: {},
		bindings: []
	};
	assertEquals(render(node, {}), '<p>hello</p>');
});

Deno.test("partial-ref with wrapper", () => {
	const node: PartialRefRNode = {
		type: 'partial-ref',
		partial: simplePartial,
		wrapper: { open: '<div>', close: '</div>' },
		slots: {},
		bindings: []
	};
	assertEquals(render(node, {}), '<div><p>hello</p></div>');
});

Deno.test("partial-ref with binding makes variable available in partial", () => {
	const partial = {
		type: 'root' as const,
		nodes: [{ type: 'print' as const, data: makeFn('mood', ['mood']) }]
	};
	const node: PartialRefRNode = {
		type: 'partial-ref',
		partial,
		wrapper: null,
		slots: {},
		bindings: [{ name: 'mood', data: makeFn('user.mood', ['user']) }]
	};
	assertEquals(render(node, { user: { mood: 'happy' } }), 'happy');
});

Deno.test("partial-ref binding does not leak to parent context", () => {
	const partial = {
		type: 'root' as const,
		nodes: [{ type: 'raw' as const, raw: 'x' }]
	};
	const node: PartialRefRNode = {
		type: 'partial-ref',
		partial,
		wrapper: null,
		slots: {},
		bindings: [{ name: 'injected', data: makeFn('"val"', []) }]
	};
	const ctx: any = {};
	render(node, ctx);
	assertEquals(ctx['injected'], undefined);
});

Deno.test("partial-ref with default slot", () => {
	const partial: RootRNode = {
		type: 'root',
		nodes: [
			{ type: 'raw', raw: '<p>' },
			{ type: 'slot', name: undefined },
			{ type: 'raw', raw: '</p>' },
		]
	};
	const node: PartialRefRNode = {
		type: 'partial-ref',
		partial,
		wrapper: null,
		slots: { default: [{ type: 'raw', raw: 'slot content' }] },
		bindings: []
	};
	assertEquals(render(node, {}), '<p>slot content</p>');
});

Deno.test("partial-ref with named slot", () => {
	const partial: RootRNode = {
		type: 'root',
		nodes: [
			{ type: 'raw', raw: 'Notice! ' },
			{ type: 'slot', name: 'message' },
		]
	};
	const node: PartialRefRNode = {
		type: 'partial-ref',
		partial,
		wrapper: null,
		slots: { message: [{ type: 'raw', raw: 'hi there' }] },
		bindings: []
	};
	assertEquals(render(node, {}), 'Notice! hi there');
});

Deno.test("slot renders empty when no content provided", () => {
	const node: SlotRNode = { type: 'slot', name: undefined };
	assertEquals(render(node, {}), '');
});

Deno.test("slot content is rendered in caller context not partial context", () => {
	// The slot content has a {{ name }} expression.
	// The partial context has name='partial-name', caller has name='caller-name'.
	// Slot content should use caller's name.
	const partial: RootRNode = {
		type: 'root',
		nodes: [{ type: 'slot', name: undefined }]
	};
	const node: PartialRefRNode = {
		type: 'partial-ref',
		partial: partial as any,
		wrapper: null,
		slots: {
			default: [{ type: 'print', data: makeFn('name', ['name']) }]
		},
		bindings: [{ name: 'name', data: makeFn('"partial-name"', []) }]
	};
	// caller ctx has name='caller-name'; partial binding overrides to 'partial-name'
	// but slot content should still see 'caller-name'
	assertEquals(render(node, { name: 'caller-name' }), 'caller-name');
});

// ---------------------------------------------------------------------------
// escapeHtml unit tests
// ---------------------------------------------------------------------------

Deno.test("escapeHtml: escapes <", () => assertEquals(escapeHtml('<'), '&lt;'));
Deno.test("escapeHtml: escapes >", () => assertEquals(escapeHtml('>'), '&gt;'));
Deno.test("escapeHtml: escapes &", () => assertEquals(escapeHtml('&'), '&amp;'));
Deno.test("escapeHtml: escapes \"", () => assertEquals(escapeHtml('"'), '&quot;'));
Deno.test("escapeHtml: escapes '", () => assertEquals(escapeHtml("'"), '&#39;'));
Deno.test("escapeHtml: leaves plain text alone", () => assertEquals(escapeHtml('hello world'), 'hello world'));
Deno.test("escapeHtml: escapes multiple chars", () => assertEquals(escapeHtml('<b>"it\'s" & fun</b>'), '&lt;b&gt;&quot;it&#39;s&quot; &amp; fun&lt;/b&gt;'));

Deno.test("print node escapes HTML", () => {
	const node: PrintRNode = { type: 'print', data: makeFn('v', ['v']) };
	assertEquals(render(node, { v: '<script>alert(1)</script>' }), '&lt;script&gt;alert(1)&lt;/script&gt;');
});

// ---------------------------------------------------------------------------
// dom-patch script auto-include (renderRoot)
// ---------------------------------------------------------------------------

// A reactive custom-element partial-ref carrying a baked-in scriptUrl.
function ceRef(tagName: string, scriptUrl: string, body: RNode[] = []): PartialRefRNode {
	return {
		type: 'partial-ref',
		customElement: true,
		callerTagName: tagName,
		callerOpenTag: [],
		partial: { type: 'root', customElement: true, scriptUrl, definitionAttrNodes: [], nodes: body },
		slots: {},
		bindings: [],
	};
}

Deno.test("auto-include: reactive custom element injects one script before </body>", () => {
	const root: RootRNode = {
		type: 'root',
		nodes: [
			{ type: 'raw', raw: '<html><body>' },
			ceRef('my-widget', '/bfdom/my-widget.js'),
			{ type: 'raw', raw: '</body></html>' },
		],
	};
	const html = renderRoot(root, {});
	assertEquals(html.match(/<script/g)?.length, 1);
	assertStringIncludes(html, '</my-widget><script src="/bfdom/my-widget.js" defer></script></body></html>');
});

Deno.test("auto-include: script appended at end when no </body>", () => {
	const root: RootRNode = { type: 'root', nodes: [ceRef('my-widget', '/bfdom/w.js')] };
	assertEquals(renderRoot(root, {}), '<my-widget></my-widget><script src="/bfdom/w.js" defer></script>');
});

Deno.test("auto-include: script src is attribute-escaped", () => {
	const root: RootRNode = { type: 'root', nodes: [ceRef('my-widget', '/bfdom/w.js?a=1&b=2')] };
	assertStringIncludes(renderRoot(root, {}), 'src="/bfdom/w.js?a=1&amp;b=2"');
});

Deno.test("auto-include: same custom element used twice yields one script (dedup)", () => {
	const root: RootRNode = {
		type: 'root',
		nodes: [ceRef('my-widget', '/bfdom/w.js'), ceRef('my-widget', '/bfdom/w.js')],
	};
	const html = renderRoot(root, {});
	assertEquals(html.match(/<script/g)?.length, 1);
});

Deno.test("auto-include: only the taken b-if branch contributes its script", () => {
	const root: RootRNode = {
		type: 'root',
		nodes: [{
			type: 'if',
			branches: [
				{ condition: makeFn('show', ['show']), nodes: [ceRef('a-x', '/bfdom/a.js')] },
				{ nodes: [ceRef('b-x', '/bfdom/b.js')] },
			],
		}],
	};
	const taken = renderRoot(root, { show: true });
	assertStringIncludes(taken, 'src="/bfdom/a.js"');
	assertEquals(taken.includes('/bfdom/b.js'), false);

	const untaken = renderRoot(root, { show: false });
	assertStringIncludes(untaken, 'src="/bfdom/b.js"');
	assertEquals(untaken.includes('/bfdom/a.js'), false);
});

Deno.test("auto-include: b-for includes script when it iterates, excludes when empty", () => {
	const root: RootRNode = {
		type: 'root',
		nodes: [{
			type: 'for',
			iterable: makeFn('items', ['items']),
			valName: 'i',
			nodes: [ceRef('row-x', '/bfdom/row.js')],
		}],
	};
	const iterated = renderRoot(root, { items: [1, 2] });
	assertEquals(iterated.match(/<script/g)?.length, 1);  // included once despite two iterations

	const empty = renderRoot(root, { items: [] });
	assertEquals(empty.includes('<script'), false);
});

Deno.test("auto-include: nested reactive partials collected; non-reactive contribute nothing", () => {
	const inner = ceRef('inner-x', '/bfdom/inner.js');
	const outer = ceRef('outer-x', '/bfdom/outer.js', [inner]);
	const plain: PartialRefRNode = {
		type: 'partial-ref',
		partial: { type: 'root', nodes: [{ type: 'raw', raw: '<p>plain</p>' }] },
		wrapper: null,
		slots: {},
		bindings: [],
	};
	const html = renderRoot({ type: 'root', nodes: [outer, plain] }, {});
	assertStringIncludes(html, 'src="/bfdom/outer.js"');
	assertStringIncludes(html, 'src="/bfdom/inner.js"');
	// First-encounter order: outer before inner.
	assertEquals(html.indexOf('/bfdom/outer.js') < html.indexOf('/bfdom/inner.js'), true);
});

Deno.test("auto-include: no reactive elements yields no script block", () => {
	const root: RootRNode = { type: 'root', nodes: [{ type: 'raw', raw: '<p>x</p>' }] };
	assertEquals(renderRoot(root, {}), '<p>x</p>');
});

Deno.test("auto-include: top-level reactive root contributes its own script", () => {
	const root: RootRNode = {
		type: 'root',
		customElement: true,
		scriptUrl: '/bfdom/self.js',
		definitionAttrNodes: [],
		nodes: [{ type: 'raw', raw: 'hi' }],
	};
	assertEquals(renderRoot(root, {}), 'hi<script src="/bfdom/self.js" defer></script>');
});

// ---------------------------------------------------------------------------
// dom-patch script auto-include (streamRenderRoot)
//
// Streaming must inject the same scripts, in the same place, as batch — these
// mirror the renderRoot cases above and additionally assert stream === batch.
// ---------------------------------------------------------------------------

Deno.test("stream auto-include: reactive custom element injects one script before </body>", () => {
	const root: RootRNode = {
		type: 'root',
		nodes: [
			{ type: 'raw', raw: '<html><body>' },
			ceRef('my-widget', '/bfdom/my-widget.js'),
			{ type: 'raw', raw: '</body></html>' },
		],
	};
	const html = streamToString(root, {});
	assertEquals(html.match(/<script/g)?.length, 1);
	assertStringIncludes(html, '</my-widget><script src="/bfdom/my-widget.js" defer></script></body></html>');
	assertEquals(html, renderRoot(root, {}));
});

Deno.test("stream auto-include: injects before </body> even when split across chunks", () => {
	// The closing tag is emitted character-by-character so </body> straddles
	// chunk boundaries — the carry logic must still find and inject before it.
	const root: RootRNode = {
		type: 'root',
		nodes: [
			{ type: 'raw', raw: '<html><body>' },
			ceRef('my-widget', '/bfdom/w.js'),
			...'</body></html>'.split('').map((c): RNode => ({ type: 'raw', raw: c })),
		],
	};
	const html = streamToString(root, {});
	assertEquals(html.match(/<script/g)?.length, 1);
	assertStringIncludes(html, '<script src="/bfdom/w.js" defer></script></body></html>');
	assertEquals(html, renderRoot(root, {}));
});

Deno.test("stream auto-include: appended at end when no </body>", () => {
	const root: RootRNode = { type: 'root', nodes: [ceRef('my-widget', '/bfdom/w.js')] };
	assertEquals(streamToString(root, {}), '<my-widget></my-widget><script src="/bfdom/w.js" defer></script>');
});

Deno.test("stream auto-include: dedup, b-if, and b-for match batch", () => {
	const ifRoot: RootRNode = {
		type: 'root',
		nodes: [{
			type: 'if',
			branches: [
				{ condition: makeFn('show', ['show']), nodes: [ceRef('a-x', '/bfdom/a.js')] },
				{ nodes: [ceRef('b-x', '/bfdom/b.js')] },
			],
		}],
	};
	assertEquals(streamToString(ifRoot, { show: true }), renderRoot(ifRoot, { show: true }));
	assertEquals(streamToString(ifRoot, { show: false }), renderRoot(ifRoot, { show: false }));

	const forRoot: RootRNode = {
		type: 'root',
		nodes: [{
			type: 'for',
			iterable: makeFn('items', ['items']),
			valName: 'i',
			nodes: [ceRef('row-x', '/bfdom/row.js')],
		}],
	};
	assertEquals(streamToString(forRoot, { items: [1, 2] }), renderRoot(forRoot, { items: [1, 2] }));
	assertEquals(streamToString(forRoot, { items: [] }).includes('<script'), false);
});

Deno.test("stream auto-include: nested partials do not inject mid-document", () => {
	const inner = ceRef('inner-x', '/bfdom/inner.js');
	const outer = ceRef('outer-x', '/bfdom/outer.js', [inner]);
	const root: RootRNode = {
		type: 'root',
		nodes: [{ type: 'raw', raw: '<body>' }, outer, { type: 'raw', raw: '</body>' }],
	};
	const html = streamToString(root, {});
	// Both scripts collected, but emitted once, together, before </body>.
	assertEquals(html.match(/<script/g)?.length, 2);
	assertStringIncludes(html, '/bfdom/outer.js" defer></script>\n<script src="/bfdom/inner.js" defer></script></body>');
	assertEquals(html, renderRoot(root, {}));
});

Deno.test("stream auto-include: no reactive elements yields no script block", () => {
	const root: RootRNode = { type: 'root', nodes: [{ type: 'raw', raw: '<body><p>x</p></body>' }] };
	assertEquals(streamToString(root, {}), '<body><p>x</p></body>');
});
