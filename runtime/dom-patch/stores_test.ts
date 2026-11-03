import { assertEquals, assertStrictEquals, assertThrows } from "jsr:@std/assert";
import { JSDOM } from "npm:jsdom";

import { BackflipStore } from "./stores.ts";
import { enqueue, flush, FLUSH_EVENT, isFlushing, register } from "./flush.ts";

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

// --- set ---------------------------------------------------------------------

const SIMPLE = `<script type="application/json" data-bf-store="s">{"a":{"n":1},"b":{"n":2},"list":[1,2]}</script>`;
type Simple = { a: { n: number }, b: { n: number }, list: number[] };

Deno.test("BackflipStore.set: data is the new value immediately", () => {
	withDocument(SIMPLE, () => {
		const store = new BackflipStore('s');
		const next = { x: 1 };
		store.set(next);
		assertStrictEquals(store.data, next);
	});
});

Deno.test("BackflipStore.set: the new value is deeply frozen", () => {
	withDocument(SIMPLE, () => {
		const store = new BackflipStore('s');
		const next = { x: { y: [1] } };
		store.set(next);
		assertThrows(() => { next.x.y.push(2); }, TypeError);
		assertThrows(() => { (next.x as Record<string, unknown>).z = 1; }, TypeError);
	});
});

Deno.test("BackflipStore.set: accepts everything JSON-like, and holes", () => {
	withDocument(SIMPLE, () => {
		const store = new BackflipStore('s');
		for (const v of ['t', 0, -1.5, true, false, null, [], {}, [1, , 3], { a: [{ b: null }] }]) {
			store.set(v);
			assertStrictEquals(store.data, v);
		}
	});
});

class Plain { x = 1; }
for (const [label, value] of [
	['undefined', undefined],
	['a nested undefined', { a: undefined }],
	['NaN', NaN],
	['Infinity', { a: [Infinity] }],
	['a function', { a: () => 1 }],
	['a symbol', Symbol('s')],
	['a bigint', 1n],
	['a Date', new Date()],
	['a class instance', { a: new Plain() }],
	['a Map', new Map()],
] as const) {
	Deno.test(`BackflipStore.set: ${label} throws and changes nothing`, () => {
		withDocument(SIMPLE, () => {
			const store = new BackflipStore('s');
			const before = store.data;
			assertThrows(() => store.set(value), TypeError, 'BackflipStore "s"');
			assertStrictEquals(store.data, before);
		});
	});
}

Deno.test("BackflipStore.set: a cycle throws; the same object twice does not", () => {
	withDocument(SIMPLE, () => {
		const store = new BackflipStore('s');
		const cyclic: Record<string, unknown> = {};
		cyclic.self = { cyclic };
		assertThrows(() => store.set(cyclic), TypeError, 'cycle');
		const shared = { n: 1 };
		store.set({ a: shared, b: shared });
		assertEquals(store.data, { a: { n: 1 }, b: { n: 1 } });
	});
});

Deno.test("BackflipStore.set: a rejected value is left unfrozen, and is checked again next time", () => {
	withDocument(SIMPLE, () => {
		const store = new BackflipStore('s');
		const good = { n: 1 };
		const value: Record<string, unknown> = { good, bad: undefined };
		assertThrows(() => store.set(value), TypeError);
		assertEquals(Object.isFrozen(value), false);
		assertEquals(Object.isFrozen(good), false);
		// `good` passed before the failure, but was not remembered as valid.
		(good as Record<string, unknown>).later = undefined;
		assertThrows(() => store.set({ good }), TypeError);
	});
});

Deno.test("BackflipStore.set: an object the author froze is still validated, and frozen under", () => {
	withDocument(SIMPLE, () => {
		const store = new BackflipStore('s');
		assertThrows(() => store.set(Object.freeze({ a: undefined })), TypeError);
		const inner = { n: 1 };
		store.set(Object.freeze({ inner }));
		assertEquals(Object.isFrozen(inner), true);
	});
});

Deno.test("BackflipStore.set: unchanged sub-objects are not walked again", () => {
	withDocument(SIMPLE, () => {
		const store = new BackflipStore('s');
		const data = store.data as Simple;
		const orig = Object.values;
		let walked = 0;
		Object.values = ((o: object) => { walked++; return orig(o); }) as typeof Object.values;
		try {
			store.set({ a: data.a, b: data.b, list: data.list });
		} finally {
			Object.values = orig;
		}
		assertEquals(walked, 1);
	});
});

Deno.test("BackflipStore.set: reads the tag first when data was never read", () => {
	withDocument(SIMPLE, () => {
		const store = new BackflipStore('s');
		store.set({ x: 1 });
		assertEquals(store.data, { x: 1 });
	});
});

Deno.test("BackflipStore.set and setAt: with no tag they throw, naming the store and the cause", () => {
	withDocument('', (doc) => {
		const store = new BackflipStore('s');
		Object.defineProperty(doc, 'readyState', { value: 'complete', configurable: true });
		assertThrows(() => store.set({}), Error, 'BackflipStore "s"');
		assertThrows(() => store.set({}), Error, 'did not ship');
		assertThrows(() => store.setAt(['a'], 1), Error, 'did not ship');
		Object.defineProperty(doc, 'readyState', { value: 'loading', configurable: true });
		assertThrows(() => store.set({}), Error, 'too early');
		assertThrows(() => store.setAt(['a'], 1), Error, 'too early');
	});
});

// An element registered with `store`, and the flushes it sees.
function listening(doc: Document, store: BackflipStore) {
	const el = doc.createElement('div');
	doc.body.append(el);
	register(store, el);
	let flushes = 0;
	el.addEventListener(FLUSH_EVENT, () => { flushes++; });
	return { el, flushes: () => flushes };
}

Deno.test("BackflipStore.set: schedules a flush for the store's elements, coalescing", async () => {
	const dom = new JSDOM(`<!DOCTYPE html><body>${SIMPLE}</body>`);
	const g = globalThis as { document?: Document };
	const prev = g.document;
	g.document = dom.window.document;
	try {
		const store = new BackflipStore('s');
		const { flushes } = listening(dom.window.document, store);
		store.set({ x: 1 });
		store.set({ x: 2 });
		assertEquals(flushes(), 0);
		await Promise.resolve();
		assertEquals(flushes(), 1);
	} finally {
		g.document = prev;
	}
});

Deno.test("BackflipStore.set: setting the current data schedules nothing", () => {
	withDocument(SIMPLE, (doc) => {
		const store = new BackflipStore('s');
		const { flushes } = listening(doc, store);
		store.set(store.data);
		flush();
		assertEquals(flushes(), 0);
	});
});

Deno.test("BackflipStore.set: throws during a flush", () => {
	withDocument(SIMPLE, (doc) => {
		const store = new BackflipStore('s');
		const { el } = listening(doc, store);
		let error: unknown;
		el.addEventListener(FLUSH_EVENT, () => {
			try {
				store.set({ x: 1 });
			} catch (e) {
				error = e;
			}
		});
		enqueue(el);
		flush();
		assertEquals(String(error).includes('during a flush'), true);
		assertEquals(isFlushing(), false);
		assertEquals(store.data, { a: { n: 1 }, b: { n: 2 }, list: [1, 2] });
	});
});

// --- setAt -------------------------------------------------------------------

Deno.test("BackflipStore.setAt: replaces along the path; everything else keeps its identity", () => {
	withDocument(SIMPLE, () => {
		const store = new BackflipStore('s');
		const before = store.data as Simple;
		store.setAt(['a', 'n'], 9);
		const after = store.data as Simple;
		assertEquals(after, { a: { n: 9 }, b: { n: 2 }, list: [1, 2] });
		assertEquals(after === before, false);
		assertEquals(after.a === before.a, false);
		assertStrictEquals(after.b, before.b);
		assertStrictEquals(after.list, before.list);
		assertEquals(before.a.n, 1);
		assertThrows(() => { after.a.n = 3; }, TypeError);
	});
});

Deno.test("BackflipStore.setAt: the last key may be new, an earlier one may not", () => {
	withDocument(SIMPLE, () => {
		const store = new BackflipStore('s');
		store.setAt(['a', 'new'], 1);
		assertEquals((store.data as { a: unknown }).a, { n: 1, new: 1 });
		assertThrows(() => store.setAt(['zzz', 'n'], 1), Error, 'missing');
	});
});

Deno.test("BackflipStore.setAt: a key into anything but an object or array throws", () => {
	withDocument(SIMPLE, () => {
		const store = new BackflipStore('s');
		assertThrows(() => store.setAt(['a', 'n', 'deep'], 1), Error, 'not an object or array');
		store.set(5);
		assertThrows(() => store.setAt(['a'], 1), Error, 'not an object or array');
	});
});

Deno.test("BackflipStore.setAt: keys are own properties", () => {
	withDocument(SIMPLE, () => {
		const store = new BackflipStore('s');
		assertThrows(() => store.setAt(['constructor', 'name'], 'x'), Error, 'missing');
		store.setAt(['__proto__'], { polluted: true });
		const data = store.data as Record<string, unknown>;
		assertEquals(Object.getPrototypeOf(data), Object.prototype);
		assertEquals(Object.hasOwn(data, '__proto__'), true);
		assertEquals(data.polluted, undefined);
	});
});

Deno.test("BackflipStore.setAt: an array index must be a non-negative integer", () => {
	withDocument(SIMPLE, () => {
		const store = new BackflipStore('s');
		for (const key of [-1, 1.5, 'length', 'x']) {
			assertThrows(() => store.setAt(['list', key], 1), Error, 'not an array index');
		}
		store.setAt(['list', 0], 7);
		assertEquals((store.data as Simple).list, [7, 2]);
	});
});

Deno.test("BackflipStore.setAt: an index past the end leaves holes", () => {
	withDocument(SIMPLE, () => {
		const store = new BackflipStore('s');
		store.setAt(['list', 4], 5);
		const list = (store.data as Simple).list;
		assertEquals(list.length, 5);
		assertEquals(3 in list, false);
		assertEquals(list[4], 5);
	});
});

Deno.test("BackflipStore.setAt: a value already there copies nothing and schedules nothing", () => {
	withDocument(SIMPLE, (doc) => {
		const store = new BackflipStore('s');
		const before = store.data;
		const { flushes } = listening(doc, store);
		store.setAt(['a', 'n'], 1);
		flush();
		assertStrictEquals(store.data, before);
		assertEquals(flushes(), 0);
	});
});

Deno.test("BackflipStore.setAt: an invalid value throws as set does", () => {
	withDocument(SIMPLE, () => {
		const store = new BackflipStore('s');
		const before = store.data;
		assertThrows(() => store.setAt(['a', 'n'], undefined), TypeError);
		assertStrictEquals(store.data, before);
	});
});

Deno.test("BackflipStore: a subclass method changes the store", () => {
	class Widgets extends BackflipStore {
		rename(id: string, name: string) { this.setAt([id, 'name'], name); }
	}
	withDocument(TAG, () => {
		const store = new Widgets('widgets');
		store.rename('42', 'New');
		assertEquals((store.data as Record<string, { name: string }>)['42'].name, 'New');
	});
});
