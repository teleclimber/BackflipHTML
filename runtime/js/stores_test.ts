import { assertEquals, assertThrows } from "jsr:@std/assert";

import type { RootRNode, PartialRefRNode, RNode, rfn } from "./render.ts";
import { render, renderRoot, streamRenderRoot } from "./render.ts";

function makeFn(code: string, vars: string[]): rfn {
	return { fn: new Function(...vars, `return ${code};`) as (...args: any[]) => any, vars };
}

const print = (code: string, vars: string[]): RNode => ({ type: 'print', data: makeFn(code, vars) });

// <b-unwrap b-name="card" b-store:widgets>{{ widgets.data.a.name }}</b-unwrap>
const card: RootRNode = {
	type: 'root', name: 'card',
	stores: [{ name: 'widgets', shipped: false }],
	nodes: [print('widgets.data.a.name', ['widgets'])],
};

// <my-widget b-store:widgets b-generate="full">{{ widgets.data.a.name }}</my-widget>, shipped.
const widget: RootRNode = {
	type: 'root', name: 'my-widget', customElement: true,
	scripts: [{ url: '/static/bfdom/my-widget.js', kind: 'entry' }],
	stores: [{ name: 'widgets', shipped: true, src: '/static/stores/widgets.js' }],
	definitionAttrNodes: [],
	nodes: [print('widgets.data.a.name', ['widgets'])],
};

const callCard: PartialRefRNode = { type: 'partial-ref', partial: card, slots: {}, bindings: [] };
const callWidget: PartialRefRNode = { type: 'partial-ref', partial: widget, slots: {}, bindings: [], customElement: true, callerTagName: 'my-widget' };

function page(nodes: RNode[], stores?: RootRNode['stores']): RootRNode {
	return {
		type: 'root', name: 'page', ...(stores ? { stores } : {}),
		nodes: [{ type: 'raw', raw: '<html><body>' }, ...nodes, { type: 'raw', raw: '</body></html>' }],
	};
}

const WIDGETS = { a: { name: 'Gizmo', owner: 'ann' } };

function both(root: RootRNode, ctx: object, stores?: Record<string, unknown>): string {
	const batch = renderRoot(root, ctx, undefined, stores);
	assertEquals(Array.from(streamRenderRoot(root, ctx, undefined, stores)).join(''), batch);
	return batch;
}

// --- server render -------------------------------------------------------------

Deno.test("stores: a declaring partial reads its store's data", () => {
	assertEquals(both(page([callCard]), {}, { widgets: WIDGETS }), '<html><body>Gizmo</body></html>');
});

Deno.test("stores: the root partial gets its declared stores next to ctx", () => {
	const root = page([print('widgets.data.a.owner + title', ['widgets', 'title'])], [{ name: 'widgets', shipped: false }]);
	assertEquals(both(root, { title: '!' }, { widgets: WIDGETS }), '<html><body>ann!</body></html>');
});

Deno.test("stores: a partial that does not declare a store does not see it", () => {
	const reader: RootRNode = { type: 'root', nodes: [print('typeof widgets', ['widgets'])] };
	const root = page([{ type: 'partial-ref', partial: reader, slots: {}, bindings: [] }], [{ name: 'widgets', shipped: false }]);
	assertEquals(both(root, {}, { widgets: WIDGETS }), '<html><body>undefined</body></html>');
});

Deno.test("stores: slot content sees the caller's stores", () => {
	const shell: RootRNode = { type: 'root', nodes: [{ type: 'slot', name: undefined }] };
	const call: PartialRefRNode = { type: 'partial-ref', partial: shell, slots: { default: [print('widgets.data.a.name', ['widgets'])] }, bindings: [] };
	assertEquals(both(page([call], [{ name: 'widgets', shipped: false }]), {}, { widgets: WIDGETS }), '<html><body>Gizmo</body></html>');
});

Deno.test("stores: every declaring partial gets the same store object", () => {
	const seen: unknown[] = [];
	const grab: RootRNode = {
		type: 'root', stores: [{ name: 'widgets', shipped: false }],
		nodes: [{ type: 'print', data: { vars: ['widgets'], fn: (w: unknown) => { seen.push(w); return ''; } } }],
	};
	const call: PartialRefRNode = { type: 'partial-ref', partial: grab, slots: {}, bindings: [] };
	renderRoot(page([call, call]), {}, undefined, { widgets: WIDGETS });
	assertEquals(seen.length, 2);
	assertEquals(seen[0] === seen[1], true);
	assertEquals((seen[0] as { data: unknown }).data, WIDGETS);
});

Deno.test("stores: a nested render uses stores and emits no tags", () => {
	assertEquals(render(callWidget, {}, undefined, { widgets: WIDGETS }), '<my-widget>Gizmo</my-widget>');
});

// --- render errors ---------------------------------------------------------------

Deno.test("stores: a rendered partial declaring a store not passed is an error", () => {
	assertThrows(() => renderRoot(page([callCard]), {}), Error, 'partial "card" declares b-store:widgets, but no store "widgets" was passed to the renderer');
	assertThrows(() => renderRoot(page([callCard]), {}, undefined, { other: 1 }), Error, 'no store "widgets" was passed');
	assertThrows(() => render(callWidget, {}), Error, 'partial "my-widget" declares b-store:widgets');
});

Deno.test("stores: a root declaring a store not passed is an error", () => {
	assertThrows(() => renderRoot(page([], [{ name: 'widgets', shipped: false }]), {}), Error, 'partial "page" declares b-store:widgets');
});

Deno.test("stores: a partial in an untaken branch needs no store", () => {
	const root = page([{ type: 'if', branches: [{ condition: makeFn('false', []), nodes: [callCard] }] }]);
	assertEquals(both(root, {}), '<html><body></body></html>');
});

Deno.test("stores: a root ctx key that is also a declared store is an error", () => {
	const root = page([], [{ name: 'widgets', shipped: false }]);
	assertThrows(() => renderRoot(root, { widgets: 1 }, undefined, { widgets: WIDGETS }), Error, 'ctx key "widgets" is also a store the root partial "page" declares');
});

Deno.test("stores: a ctx key matching an undeclared store is fine", () => {
	assertEquals(both(page([print('widgets', ['widgets'])]), { widgets: 'w' }, { widgets: WIDGETS }), '<html><body>w</body></html>');
});

Deno.test("stores: a shipped store that cannot be serialized is an error", () => {
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	const root = page([{ type: 'partial-ref', partial: { ...widget, nodes: [] }, slots: {}, bindings: [], customElement: true, callerTagName: 'my-widget' }]);
	assertThrows(() => renderRoot(root, {}, undefined, { widgets: cyclic }), Error, 'store "widgets" cannot be serialized to JSON');
	assertThrows(() => renderRoot(root, {}, undefined, { widgets: undefined }), Error, 'store "widgets" cannot be serialized to JSON');
});

// --- shipping ----------------------------------------------------------------------

const TAG = '<script type="application/json" data-bf-store="widgets">{"a":{"name":"Gizmo","owner":"ann"}}</script>';

Deno.test("stores: a rendered shipped store becomes a tag, its file a dependency, ahead of the scripts", () => {
	assertEquals(both(page([callWidget]), {}, { widgets: WIDGETS }),
		'<html><body><my-widget>Gizmo</my-widget>' + TAG + '\n'
		+ '<link rel="modulepreload" href="/static/stores/widgets.js">\n'
		+ '<script src="/static/bfdom/my-widget.js" type="module"></script></body></html>');
});

Deno.test("stores: a store is shipped once however many partials ship it", () => {
	const out = both(page([callWidget, callWidget]), {}, { widgets: WIDGETS });
	assertEquals(out.split('data-bf-store=').length, 2);
	assertEquals(out.split('modulepreload').length, 2);
});

Deno.test("stores: a store that is not shipped makes no tag", () => {
	const unshipped: RootRNode = { ...widget, stores: [{ name: 'widgets', shipped: false, src: '/static/stores/widgets.js' }] };
	const out = both(page([{ ...callWidget, partial: unshipped }]), {}, { widgets: WIDGETS });
	assertEquals(out.includes('data-bf-store'), false);
	assertEquals(out.includes('stores/widgets.js'), false);
});

Deno.test("stores: a shipping partial in an untaken branch or empty loop ships nothing", () => {
	const untaken = page([{ type: 'if', branches: [{ condition: makeFn('false', []), nodes: [callWidget] }] }]);
	assertEquals(both(untaken, {}, { widgets: WIDGETS }), '<html><body></body></html>');
	const empty = page([{ type: 'for', iterable: makeFn('[]', []), valName: 'x', nodes: [callWidget] }]);
	assertEquals(both(empty, {}, { widgets: WIDGETS }), '<html><body></body></html>');
});

Deno.test("stores: a passed store no rendered partial declares is ignored", () => {
	assertEquals(both(page([]), {}, { widgets: WIDGETS, other: { x: 1 } }), '<html><body></body></html>');
});

Deno.test("stores: the JSON is escaped so it cannot end the tag", () => {
	const data = { s: '</script><!-- & \u2028\u2029 é /' };
	const out = renderRoot(page([callWidget]), {}, undefined, { widgets: { a: { name: 'x' }, ...data } });
	const json = out.slice(out.indexOf('data-bf-store="widgets">') + 'data-bf-store="widgets">'.length, out.indexOf('</script>', out.indexOf('data-bf-store')));
	assertEquals(json, '{"a":{"name":"x"},"s":"\\u003C/script\\u003E\\u003C!-- \\u0026 \\u2028\\u2029 é /"}');
	assertEquals(JSON.parse(json).s, data.s);
});
