import { assertEquals } from "jsr:@std/assert";
import { JSDOM, VirtualConsole } from "npm:jsdom";

import { enqueue, flush, FLUSH_EVENT, isFlushing, register, storeChanged } from "./flush.ts";

// Elements `a` and `b`, with `a` holding `b`, and a log of the events each receives.
function elements() {
	// A silent console: jsdom reports a listener's exception to it.
	const dom = new JSDOM(`<!DOCTYPE html><body><div id="a"><div id="b"></div></div></body>`, { virtualConsole: new VirtualConsole() });
	const doc = dom.window.document;
	const a = doc.querySelector('#a')!, b = doc.querySelector('#b')!;
	const log: string[] = [];
	for (const el of [a, b]) el.addEventListener(FLUSH_EVENT, () => { log.push(el.id); }, { capture: true });
	return { a, b, log };
}

const microtask = () => Promise.resolve();

Deno.test("flush: enqueue runs on the next microtask, once for several changes", async () => {
	const { b, log } = elements();
	enqueue(b);
	enqueue(b);
	assertEquals(log, []);
	await microtask();
	// `a` sees the event on its way down to `b`.
	assertEquals(log, ['a', 'b']);
});

Deno.test("flush: flush() runs right away, and the microtask finds nothing left", async () => {
	const { b, log } = elements();
	enqueue(b);
	flush();
	assertEquals(log, ['a', 'b']);
	await microtask();
	assertEquals(log, ['a', 'b']);
});

Deno.test("flush: ancestors see the event first, whatever the list's order", () => {
	const { a, b, log } = elements();
	enqueue(b);
	enqueue(a);
	flush();
	assertEquals(log, ['a', 'b', 'a']);
});

Deno.test("flush: an element added during the flush is visited, even one already visited", () => {
	const { a, b, log } = elements();
	let once = true;
	b.addEventListener(FLUSH_EVENT, () => {
		if (!once) return;
		once = false;
		enqueue(b);
	});
	enqueue(b);
	flush();
	assertEquals(log, ['a', 'b', 'a', 'b']);
	assertEquals(a.isConnected, true);
});

Deno.test("flush: a disconnected element is skipped", () => {
	const { b, log } = elements();
	enqueue(b);
	b.remove();
	flush();
	assertEquals(log, []);
});

Deno.test("flush: flush() during a flush does nothing, and isFlushing says so", () => {
	const { b, log } = elements();
	const flushing: boolean[] = [];
	b.addEventListener(FLUSH_EVENT, () => {
		flushing.push(isFlushing());
		flush();
	});
	assertEquals(isFlushing(), false);
	enqueue(b);
	flush();
	assertEquals(flushing, [true]);
	assertEquals(log, ['a', 'b']);
	assertEquals(isFlushing(), false);
});

Deno.test("flush: a throwing listener does not stop the loop", () => {
	const { a, b, log } = elements();
	b.addEventListener(FLUSH_EVENT, () => { throw new Error('boom'); });
	const other = a.ownerDocument.createElement('div');
	a.ownerDocument.body.append(other);
	other.addEventListener(FLUSH_EVENT, () => { log.push('other'); });
	enqueue(b);
	enqueue(other);
	flush();
	assertEquals(log, ['a', 'b', 'other']);
	assertEquals(isFlushing(), false);
});

Deno.test("flush: the running state clears if the loop itself throws", () => {
	const { b } = elements();
	enqueue(b);
	(b as unknown as { dispatchEvent: () => void }).dispatchEvent = () => { throw new Error('boom'); };
	let thrown = false;
	try {
		flush();
	} catch {
		thrown = true;
	}
	assertEquals(thrown, true);
	assertEquals(isFlushing(), false);
});

Deno.test("flush: storeChanged enqueues the elements registered with that store only", () => {
	const { a, b, log } = elements();
	const store = {}, other = {};
	register(store, b);
	register(other, a);
	storeChanged(store);
	flush();
	assertEquals(log, ['a', 'b']);
});

Deno.test("flush: a disconnected element stays registered", () => {
	const { a, b, log } = elements();
	const store = {};
	register(store, b);
	b.remove();
	storeChanged(store);
	flush();
	assertEquals(log, []);
	a.append(b);
	storeChanged(store);
	flush();
	assertEquals(log, ['a', 'b']);
});

Deno.test("flush: a store with nothing registered schedules nothing", () => {
	storeChanged({});
	flush();
	assertEquals(isFlushing(), false);
});
