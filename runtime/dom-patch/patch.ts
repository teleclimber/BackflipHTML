/// <reference lib="dom" />
// Browser-side helpers imported by generated dom-patch modules.

/**
 * Replace everything between two marker comments among `parent`'s direct children
 * with `node`. The markers themselves survive, so the range stays patchable.
 */
export function replaceBetween(parent: Node, startMarker: string, endMarker: string, node: Node): void {
	let start: ChildNode | null = null, end: ChildNode | null = null;
	for (const child of parent.childNodes) {
		if (child.nodeType !== 8) continue;
		if (child.nodeValue === startMarker) start = child;
		else if (child.nodeValue === endMarker) end = child;
	}
	if (!start || !end) {
		console.error(`BackflipHTML: comment markers ${startMarker} / ${endMarker} not found; skipping update`, parent);
		return;
	}
	let n = start.nextSibling;
	while (n && n !== end) {
		const next = n.nextSibling;
		parent.removeChild(n);
		n = next;
	}
	parent.insertBefore(node, end);
}

/** The generated shell a custom element drives: it patches the element's subtree. */
export interface BackflipShell {
	update(name: string): void;
}

// Resolved at load, so this module can also be imported where there is no DOM.
const ElementBase = (globalThis.HTMLElement ?? class {}) as typeof HTMLElement;

/**
 * Base class of every generated custom element class. The generated subclass sets
 * `bfShell` and `bfDeclared`; this class runs the lifecycle and forwards attribute
 * changes to the shell.
 *
 * Nothing runs in the constructor: a custom element constructor may not inspect its
 * attributes or children, which is exactly what the shell does. Everything on the
 * element is `bf`-prefixed, leaving the plain namespace to an author subclass.
 */
export class BackflipElement extends ElementBase {
	/** The generated shell class, constructed with the element on init. */
	static bfShell: new (ce: BackflipElement) => BackflipShell;
	/** The partial's declared `b-attr` names. */
	static bfDeclared: string[] = [];

	static get observedAttributes(): string[] {
		return this.bfDeclared;
	}

	/** The shell instance, set once the element is connected and the document has parsed. */
	bfPatch?: BackflipShell;
	bfPending?: Set<string> | null;

	connectedCallback(): void {
		this.bfInit();
	}

	attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
		// setAttribute with an unchanged value still fires this.
		if (oldValue === newValue) return;
		if (!this.bfPatch) {
			// Upgrade replays every observed attribute before connectedCallback, and the
			// server-rendered DOM already matches those. A change that really happened
			// before init is replayed by bfInit.
			(this.bfPending ??= new Set()).add(name);
			return;
		}
		this.bfPatch.update(name);
	}

	// Idempotent, since connectedCallback fires again whenever the element is moved.
	bfInit(): void {
		if (this.bfPatch) return;
		if (this.ownerDocument.readyState === 'loading') {
			// Connected by the parser: our children are not all here yet.
			this.ownerDocument.addEventListener('DOMContentLoaded', () => this.bfInit(), { once: true });
			return;
		}
		this.bfCheckObserved();
		const cls = this.constructor as typeof BackflipElement;
		this.bfPatch = new cls.bfShell(this);
		if (this.bfPending) {
			for (const name of this.bfPending) this.bfPatch.update(name);
			this.bfPending = null;
		}
	}

	// observedAttributes is read once, at define() time, off the registered class, so
	// a subclass that overrides it without spreading loses reactivity silently.
	bfCheckObserved(): void {
		const cls = this.constructor as typeof BackflipElement;
		const observed = cls.observedAttributes ?? [];
		const missing = cls.bfDeclared.filter(n => !observed.includes(n));
		if (missing.length) {
			console.error(`BackflipHTML <${this.localName}>: observedAttributes is missing ${missing.join(', ')}; a subclass overriding it must spread super.observedAttributes`, this);
		}
	}
}
