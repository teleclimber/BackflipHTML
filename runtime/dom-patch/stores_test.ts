import { assertEquals, assertStrictEquals, assertThrows } from "jsr:@std/assert";
import { JSDOM } from "npm:jsdom";

import { BackflipStore } from "./stores.ts";

// Run `fn` with `html` as the global document.
function withDocument(html: string, fn: (doc: Document) => void): void {
	const dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`);
	const g = globalThis as { document?: Document };
	const prev = g.document;
	g.document = dom.window.document;
	try {
		fn(dom.window.document);
	} finally {
		g.document = prev;
	}
}

const TAG = `<script type="application/json" data-bf-store="widgets">{"42":{"name":"Gizmo","tags":["a"]}}</script>`;

Deno.test("BackflipStore: data is parsed from the store's tag", () => {
	withDocument(TAG, () => {
		assertEquals(new BackflipStore('widgets').data, { '42': { name: 'Gizmo', tags: ['a'] } });
	});
});

Deno.test("BackflipStore: every read returns the same object", () => {
	withDocument(TAG, () => {
		const store = new BackflipStore('widgets');
		assertStrictEquals(store.data, store.data);
	});
});

Deno.test("BackflipStore: data is deeply frozen, so writes throw", () => {
	withDocument(TAG, () => {
		const data = new BackflipStore('widgets').data as Record<string, { name: string, tags: string[] }>;
		assertThrows(() => { data['42'].name = 'x'; }, TypeError);
		assertThrows(() => { data['7'] = { name: 'y', tags: [] }; }, TypeError);
		assertThrows(() => { data['42'].tags.push('b'); }, TypeError);
	});
});

Deno.test("BackflipStore: data is undefined on a page that did not ship the store", () => {
	withDocument(TAG, () => {
		assertEquals(new BackflipStore('users').data, undefined);
	});
	assertEquals(new BackflipStore('widgets').data, undefined);
});

Deno.test("BackflipStore: a miss is not cached", () => {
	withDocument('', (doc) => {
		const store = new BackflipStore('widgets');
		assertEquals(store.data, undefined);
		doc.body.insertAdjacentHTML('beforeend', TAG);
		assertEquals(store.data, { '42': { name: 'Gizmo', tags: ['a'] } });
	});
});

Deno.test("BackflipStore: reads only its own tag, whatever the order", () => {
	withDocument(`<script type="application/json" data-bf-store="users">{"ann":1}</script>${TAG}`, () => {
		assertEquals(new BackflipStore('users').data, { ann: 1 });
		assertEquals((new BackflipStore('widgets').data as Record<string, unknown>)['42'] !== undefined, true);
	});
});

Deno.test("BackflipStore: a subclass adds methods that read data", () => {
	class Widgets extends BackflipStore {
		names() { return Object.values(this.data as Record<string, { name: string }>).map(w => w.name); }
	}
	withDocument(TAG, () => {
		assertEquals(new Widgets('widgets').names(), ['Gizmo']);
	});
});
