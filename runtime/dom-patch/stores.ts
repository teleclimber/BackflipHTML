/// <reference lib="dom" />
// Browser-side store base class. A store file's default export is an instance:
// `export default new BackflipStore('widgets')`, or a subclass adding methods.

import { isFlushing, storeChanged } from './flush.js';

/** A key of an object, or an index of an array, along a path into store data. */
type Key = string | number;

/**
 * A named store. `data` is the store's data, read from the JSON tag a page render
 * ships for it, and replaced by `set` and `setAt`. Everything else on the class is
 * free for subclasses.
 */
export class BackflipStore {
	#name: string;
	#data: unknown;
	#loaded = false;

	constructor(name: string) {
		this.#name = name;
	}

	/**
	 * Parsed from the store's tag on first access and deeply frozen, so every read
	 * returns the same object until a `set`, and a write throws. Undefined on a page
	 * that did not ship the store; a miss is not cached, so a later read still finds a
	 * tag parsed since.
	 */
	get data(): unknown {
		return this.#load() ? this.#data : undefined;
	}

	/**
	 * Replace the data and schedule a flush. The value must be JSON-like, and is deeply
	 * frozen. Setting the current data does nothing.
	 */
	set(data: unknown): void {
		if (isFlushing()) throw new Error(`${this.#label()}: set during a flush. Patching reads one snapshot of the data; make the change after the flush.`);
		this.#requireTag();
		if (data === this.#data) return;
		this.#data = accept(data, this.#label());
		storeChanged(this);
	}

	/**
	 * Set the value at `path`, copying each object or array along it, so everything else
	 * keeps its identity. The last key may be new.
	 */
	setAt(path: Key[], value: unknown): void {
		this.#requireTag();
		const next = withValueAt(this.#data, path, 0, value, this.#label());
		if (next !== this.#data) this.set(next);
	}

	#label(): string {
		return `BackflipStore "${this.#name}"`;
	}

	#load(): boolean {
		if (!this.#loaded) {
			const tag = globalThis.document?.querySelector(`script[type="application/json"][data-bf-store="${this.#name}"]`);
			if (!tag) return false;
			this.#data = accept(JSON.parse(tag.textContent ?? ''), this.#label());
			this.#loaded = true;
		}
		return true;
	}

	#requireTag(): void {
		if (this.#load()) return;
		const cause = globalThis.document?.readyState === 'loading'
			? 'the document is still parsing, so this change came too early'
			: 'the page did not ship this store';
		throw new Error(`${this.#label()}: no store data tag on the page: ${cause}.`);
	}
}

// Every object known to be valid and frozen. Data that shares unchanged sub-objects
// with the data before it only has its new path walked.
const accepted = new WeakSet<object>();

// Validate `value` in full, then deeply freeze it. Nothing is frozen or remembered
// unless the whole value is valid, so a rejected value stays as the author made it.
function accept<T>(value: T, label: string): T {
	const fresh = new Set<object>();
	const walking = new Set<object>();
	const walk = (v: unknown): void => {
		if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
		if (typeof v === 'number' && Number.isFinite(v)) return;
		if (typeof v !== 'object') throw new TypeError(`${label}: data must be JSON-like, got ${String(v)}`);
		if (accepted.has(v) || fresh.has(v)) return;
		if (walking.has(v)) throw new TypeError(`${label}: data must be JSON-like, but has a cycle`);
		if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype) {
			throw new TypeError(`${label}: data must be JSON-like, got a ${v.constructor?.name ?? 'non-plain'} object`);
		}
		walking.add(v);
		for (const child of Object.values(v)) walk(child);
		walking.delete(v);
		fresh.add(v);
	};
	walk(value);
	for (const o of fresh) {
		Object.freeze(o);
		accepted.add(o);
	}
	return value;
}

// `node` with the value at `path[i]` onward replaced, or `node` itself if it already
// holds it. Keys are read and written as own properties, so `constructor` is missing
// and `__proto__` is an ordinary key.
function withValueAt(node: unknown, path: Key[], i: number, value: unknown, label: string): unknown {
	const fail = (reason: string) => new Error(`${label}: setAt ${JSON.stringify(path)}: ${reason}`);
	if (node === null || typeof node !== 'object') throw fail(`${JSON.stringify(path.slice(0, i))} is not an object or array`);
	const key = path[i];
	if (Array.isArray(node) && !(Number.isInteger(key) && (key as number) >= 0)) throw fail(`${JSON.stringify(key)} is not an array index`);
	const has = Object.hasOwn(node, key);
	const last = i === path.length - 1;
	if (!last && !has) throw fail(`${JSON.stringify(key)} is missing`);
	const current = (node as Record<Key, unknown>)[key];
	const next = last ? value : withValueAt(current, path, i + 1, value, label);
	if (has && next === current) return node;
	const copy = Array.isArray(node) ? node.slice() : { ...node };
	Object.defineProperty(copy, key, { value: next, writable: true, enumerable: true, configurable: true });
	return copy;
}
