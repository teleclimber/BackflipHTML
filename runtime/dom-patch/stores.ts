/// <reference lib="dom" />
// Browser-side store base class. A store file's default export is an instance:
// `export default new BackflipStore('widgets')`, or a subclass adding methods.

/**
 * A named store. `data` is the store's data, read from the JSON tag a page render
 * ships for it. Everything else on the class is free for subclasses.
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
	 * returns the same object and a write throws. Undefined on a page that did not
	 * ship the store; a miss is not cached, so a later read still finds a tag parsed
	 * since.
	 */
	get data(): unknown {
		if (!this.#loaded) {
			const tag = globalThis.document?.querySelector(`script[type="application/json"][data-bf-store="${this.#name}"]`);
			if (!tag) return undefined;
			this.#data = deepFreeze(JSON.parse(tag.textContent ?? ''));
			this.#loaded = true;
		}
		return this.#data;
	}
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const v of Object.values(value)) deepFreeze(v);
	}
	return value;
}
