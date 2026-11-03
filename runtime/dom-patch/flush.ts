/// <reference lib="dom" />
// The flush: every change to a store or an attribute adds elements to one list, and a
// microtask works through it, dispatching an event on each element for its shell to
// sync. The event's capture phase reaches ancestors first, so parents patch before
// children whatever the list's order.

export const FLUSH_EVENT = 'bf-store-flush';

const registered = new WeakMap<object, Set<WeakRef<Element>>>();
const pending = new Set<Element>();
let flushing = false;
let scheduled = false;

/** Add `element` to the list whenever `store` changes. Held weakly, so it can be collected. */
export function register(store: object, element: Element): void {
	let elements = registered.get(store);
	if (!elements) registered.set(store, elements = new Set());
	elements.add(new WeakRef(element));
}

/** Add every element registered with `store` to the list. */
export function storeChanged(store: object): void {
	const elements = registered.get(store);
	if (!elements) return;
	for (const ref of elements) {
		const element = ref.deref();
		if (element) enqueue(element);
		else elements.delete(ref);
	}
}

/** Add `element` to the list and, if no flush is running, schedule one. */
export function enqueue(element: Element): void {
	pending.add(element);
	if (flushing || scheduled) return;
	scheduled = true;
	queueMicrotask(flush);
}

export function isFlushing(): boolean {
	return flushing;
}

/**
 * Patch the DOM now, for code that must read it right after a change. Does nothing
 * during a flush. Dispatches never nest: a patch can only add to the list.
 */
export function flush(): void {
	if (flushing) return;
	flushing = true;
	try {
		// A Set's iteration visits what is added to it during the loop.
		for (const element of pending) {
			pending.delete(element);
			if (!element.isConnected) continue;
			// The element's own window: an Event from another realm is rejected.
			const { Event } = element.ownerDocument.defaultView!;
			element.dispatchEvent(new Event(FLUSH_EVENT, { composed: true }));
		}
	} finally {
		flushing = false;
		scheduled = false;
	}
}
