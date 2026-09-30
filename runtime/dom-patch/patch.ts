/// <reference lib="dom" />
// Browser-side runtime imported by generated dom-patch modules. A module describes
// its partial's patchable sites as data; this file does the patching.

import { render, activeBranchIndex, execFn, type rfn, type IfRNode } from '../js/render.js';

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

// --- descriptors ------------------------------------------------------------
//
// `bfid` locates an element within the branch's ref element by its `data-bfid`;
// null means the ref element itself.

/** A dynamic attribute: set to the expression's value, or toggled when `bool`. */
export interface AttrSiteDesc {
	bfid: string | null;
	attr: string;
	bool?: boolean;
	expr: rfn;
}

/** A print: the text between two marker comments, replaced with the expression's value. */
export interface PrintSiteDesc {
	bfid: string | null;
	markers: [string, string];
	expr: rfn;
}

export type SiteDesc = AttrSiteDesc | PrintSiteDesc;

/**
 * A `b-if` set: re-rendered from `snapshot` between its markers when a condition var
 * changes the winning branch. `subtreeVars` are the vars used anywhere in its branch
 * content; a change to one is forwarded to the active branch.
 */
export interface SetDesc {
	bfid: string | null;
	markers: [string, string];
	snapshot: IfRNode;
	subtreeVars: string[];
	/** Index-aligned with the snapshot's branches; null for a branch with nothing to patch. */
	branches: (BranchDesc | null)[];
}

/** A subtree that is wholly present or wholly absent: its own sites, and the sets it owns. */
export interface BranchDesc {
	sites: SiteDesc[];
	sets: SetDesc[];
}

// --- patching ---------------------------------------------------------------

type Data = Record<string, unknown>;

interface SetState {
	desc: SetDesc;
	/** Vars in the set's branch conditions: a change can move the winning branch. */
	condVars: Set<string>;
	/** The winning branch index, or -1 when none matches. */
	active: number;
	/** Patch-branch per branch index, created when that branch is rendered. */
	children: Map<number, PatchBranch>;
}

/**
 * Patches one branch's subtree, found under `refElem`. On construction it records each
 * owned set's active branch — without rendering, since the server already emitted it —
 * and creates that branch's patch-branch.
 */
export class PatchBranch {
	desc: BranchDesc;
	refElem: Element;
	sets: SetState[];

	constructor(desc: BranchDesc, refElem: Element, data: Data) {
		this.desc = desc;
		this.refElem = refElem;
		this.sets = desc.sets.map(d => ({
			desc: d,
			condVars: new Set(d.snapshot.branches.flatMap(b => b.condition?.vars ?? [])),
			active: activeBranchIndex(d.snapshot, data),
			children: new Map(),
		}));
		for (const s of this.sets) this.createChild(s, s.active, data);
	}

	/**
	 * Apply a change to var `name`. Sets run first: a re-render replaces whole subtrees,
	 * so this branch's own sites are patched against the DOM that results. For each set
	 * the var drives, a condition var re-renders it; a subtree var is forwarded to the
	 * active branch; a var that is both does one or the other, never both.
	 */
	update(name: string, data: Data): void {
		for (const s of this.sets) {
			const inCond = s.condVars.has(name);
			const inSub = s.desc.subtreeVars.includes(name);
			if (inCond && this.renderIf(s, data)) continue;
			if (inSub) s.children.get(s.active)?.update(name, data);
		}

		// One element lookup per target, in site order.
		const byTarget = new Map<string | null, SiteDesc[]>();
		for (const site of this.desc.sites) {
			if (!site.expr.vars.includes(name)) continue;
			const group = byTarget.get(site.bfid);
			if (group) group.push(site);
			else byTarget.set(site.bfid, [site]);
		}
		for (const [bfid, sites] of byTarget) {
			const elem = this.target(bfid);
			if (!elem) continue;
			for (const site of sites) patchSite(elem, site, data);
		}
	}

	// Swap in the winning branch if it changed; returns whether it did. The fragment is
	// parsed against the target element so the branch HTML gets its real parent context
	// (a <tr> under a <tbody> survives).
	renderIf(s: SetState, data: Data): boolean {
		const idx = activeBranchIndex(s.desc.snapshot, data);
		if (idx === s.active) return false;
		const elem = this.target(s.desc.bfid);
		if (!elem) return false;
		s.children.delete(s.active);
		s.active = idx;
		const range = elem.ownerDocument.createRange();
		range.selectNodeContents(elem);
		const frag = range.createContextualFragment(render(s.desc.snapshot, data));
		replaceBetween(elem, s.desc.markers[0], s.desc.markers[1], frag);
		this.createChild(s, idx, data);
		return true;
	}

	createChild(s: SetState, idx: number, data: Data): void {
		const desc = s.desc.branches[idx];
		if (!desc || s.children.has(idx)) return;
		const elem = this.target(s.desc.bfid);
		if (elem) s.children.set(idx, new PatchBranch(desc, elem, data));
	}

	// The element a site or set is anchored to. A missing one means the rendered DOM
	// diverged from the compiled template, so it is reported rather than skipped silently.
	target(bfid: string | null): Element | null {
		if (bfid === null) return this.refElem;
		const elem = this.refElem.querySelector(`[data-bfid="${bfid}"]`);
		if (!elem) console.error(`BackflipHTML: element [data-bfid="${bfid}"] not found; skipping update`, this.refElem);
		return elem;
	}
}

function patchSite(elem: Element, site: SiteDesc, data: Data): void {
	const value = execFn(site.expr, data);
	if ('attr' in site) {
		if (!site.bool) elem.setAttribute(site.attr, String(value));
		else if (value) elem.setAttribute(site.attr, '');
		else elem.removeAttribute(site.attr);
		return;
	}
	// A text node, never markup: siblings are preserved and the value is not parsed.
	replaceBetween(elem, site.markers[0], site.markers[1], elem.ownerDocument.createTextNode(String(value)));
}

// --- the shell --------------------------------------------------------------

/**
 * Base class of every generated shell (`BackflipMyWidget`). The subclass declares the
 * partial's attributes and its root branch; the shell reads the attributes off the
 * element and hands every change to the root patch-branch.
 */
export class BackflipShell {
	/** Each declared `b-attr`, and whether it is read as a string or a boolean. */
	static bfAttrs: Record<string, 'string' | 'bool'> = {};
	static bfRoot: BranchDesc = { sites: [], sets: [] };

	ce: Element;
	pb: PatchBranch;

	constructor(ce: Element) {
		this.ce = ce;
		this.pb = new PatchBranch((this.constructor as typeof BackflipShell).bfRoot, ce, this.collectData());
	}

	collectData(): Data {
		const data: Data = {};
		for (const [name, type] of Object.entries((this.constructor as typeof BackflipShell).bfAttrs)) {
			data[name] = type === 'bool' ? this.ce.hasAttribute(name) : this.ce.getAttribute(name) ?? '';
		}
		return data;
	}

	update(name: string): void {
		this.pb.update(name, this.collectData());
	}
}

// --- the custom element -----------------------------------------------------

// Resolved at load, so this module can also be imported where there is no DOM.
const ElementBase = (globalThis.HTMLElement ?? class {}) as typeof HTMLElement;

/**
 * Base class of every generated custom element class. The generated subclass sets
 * `bfShell`; this class observes the shell's declared attributes, runs the lifecycle
 * and forwards attribute changes to the shell.
 *
 * Nothing runs in the constructor: a custom element constructor may not inspect its
 * attributes or children, which is exactly what the shell does. Everything on the
 * element is `bf`-prefixed, leaving the plain namespace to an author subclass.
 */
export class BackflipElement extends ElementBase {
	/** The generated shell class, constructed with the element on init. */
	static bfShell?: typeof BackflipShell;

	static get observedAttributes(): string[] {
		return Object.keys(this.bfShell?.bfAttrs ?? {});
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
		this.bfPatch = new cls.bfShell!(this);
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
		const missing = Object.keys(cls.bfShell?.bfAttrs ?? {}).filter(n => !observed.includes(n));
		if (missing.length) {
			console.error(`BackflipHTML <${this.localName}>: observedAttributes is missing ${missing.join(', ')}; a subclass overriding it must spread super.observedAttributes`, this);
		}
	}
}
