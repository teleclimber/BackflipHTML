/// <reference lib="dom" />
// Browser-side runtime imported by generated dom-patch modules. A module describes
// its partial's patchable sites as data; this file does the patching.

import { render, activeBranchIndex, execFn, type rfn, type IfRNode } from '../js/render.js';

/**
 * Replace everything between two marker comments among `parent`'s direct children
 * with `node`. The markers themselves survive, so the range stays patchable.
 */
export function replaceBetween(parent: Node, startMarker: string, endMarker: string, node: Node): void {
	const range = findMarkers(parent, startMarker, endMarker);
	if (range) replaceRange(range, node);
}

// Replace everything between two sibling markers with `node`, keeping the markers.
function replaceRange([start, end]: [ChildNode, ChildNode], node: Node): void {
	let n = start.nextSibling;
	while (n && n !== end) {
		const next = n.nextSibling;
		n.remove();
		n = next;
	}
	end.before(node);
}

// The text between two sibling markers.
function textBetween([start, end]: [ChildNode, ChildNode]): string {
	let text = '';
	for (let n = start.nextSibling; n && n !== end; n = n.nextSibling) text += n.textContent ?? '';
	return text;
}

// The two marker comments among `parent`'s direct children. Missing ones mean the
// rendered DOM diverged from the compiled template, so they are reported.
function findMarkers(parent: Node, startMarker: string, endMarker: string): [ChildNode, ChildNode] | null {
	let start: ChildNode | null = null, end: ChildNode | null = null;
	for (const child of parent.childNodes) {
		if (child.nodeType !== 8) continue;
		if (child.nodeValue === startMarker) start = child;
		else if (child.nodeValue === endMarker) end = child;
	}
	if (!start || !end) {
		console.error(`BackflipHTML: comment markers ${startMarker} / ${endMarker} not found`, parent);
		return null;
	}
	return [start, end];
}

// The index of the branch rendered between a set's markers, from the branch marker
// that opens it; -1 when none is there.
function renderedBranchIndex(parent: Node, desc: SetDesc): number {
	const range = findMarkers(parent, desc.markers[0], desc.markers[1]);
	if (!range) return -1;
	for (let n = range[0].nextSibling; n && n !== range[1]; n = n.nextSibling) {
		if (n.nodeType === 8) {
			const idx = desc.branchMarkers.indexOf(n.nodeValue!);
			if (idx !== -1) return idx;
		}
	}
	return -1;
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
	/**
	 * Index-aligned with the snapshot's branches: the comment that opens each branch's
	 * content, so the DOM shows which branch is rendered.
	 */
	branchMarkers: string[];
}

/** A subtree that is wholly present or wholly absent: its own sites, and the sets it owns. */
export interface BranchDesc {
	sites: SiteDesc[];
	sets: SetDesc[];
}

// --- patching ---------------------------------------------------------------

type Data = Record<string, unknown>;

/** What a site shows in the DOM: presence for a bool attr, null for an absent attr, else text. */
type Shown = string | boolean | null;

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
 * Patches one branch's subtree, found under `refElem`. What the DOM shows is the
 * starting point, never `data`, which may have changed since the render: on
 * construction it reads each owned set's rendered branch from the DOM and creates that
 * branch's patch-branch, and each site's shown value is read from the DOM when first
 * patched. A site or set is written only when its recomputed value differs.
 */
export class PatchBranch {
	desc: BranchDesc;
	refElem: Element;
	sets: SetState[];
	/** What each site shows, index-aligned with `desc.sites`; undefined until read from the DOM. */
	shown: (Shown | undefined)[];

	constructor(desc: BranchDesc, refElem: Element, data: Data) {
		this.desc = desc;
		this.refElem = refElem;
		this.shown = desc.sites.map(() => undefined);
		this.sets = desc.sets.map(d => {
			const elem = this.target(d.bfid);
			return {
				desc: d,
				condVars: new Set(d.snapshot.branches.flatMap(b => b.condition?.vars ?? [])),
				active: elem ? renderedBranchIndex(elem, d) : -1,
				children: new Map(),
			};
		});
		for (const s of this.sets) this.createChild(s, s.active, data);
	}

	/**
	 * Apply a change to var `name`, or, with no name, recompute everything. Sets run
	 * first: a re-render replaces whole subtrees, so this branch's own sites are patched
	 * against the DOM that results. For each set the var drives, a condition var
	 * re-renders it; a subtree var is forwarded to the active branch; a var that is both
	 * does one or the other, never both.
	 */
	update(data: Data, name?: string): void {
		const all = name === undefined;
		for (const s of this.sets) {
			if ((all || s.condVars.has(name)) && this.renderIf(s, data)) continue;
			if (all || s.desc.subtreeVars.includes(name)) s.children.get(s.active)?.update(data, name);
		}

		// One element lookup per target, in site order.
		const byTarget = new Map<string | null, number[]>();
		this.desc.sites.forEach((site, i) => {
			if (!all && !site.expr.vars.includes(name)) return;
			const group = byTarget.get(site.bfid);
			if (group) group.push(i);
			else byTarget.set(site.bfid, [i]);
		});
		for (const [bfid, indexes] of byTarget) {
			const elem = this.target(bfid);
			if (!elem) continue;
			for (const i of indexes) this.shown[i] = patchSite(elem, this.desc.sites[i], data, this.shown[i]);
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

// Write the site's value unless it already shows it, reading what it shows from the
// DOM when `shown` is undefined. Returns what the site shows afterwards.
function patchSite(elem: Element, site: SiteDesc, data: Data, shown: Shown | undefined): Shown | undefined {
	const value = execFn(site.expr, data);
	if ('attr' in site) {
		if (site.bool) {
			const on = Boolean(value);
			if (on === (shown === undefined ? elem.hasAttribute(site.attr) : shown)) return on;
			if (on) elem.setAttribute(site.attr, '');
			else elem.removeAttribute(site.attr);
			return on;
		}
		const text = String(value);
		if (text !== (shown === undefined ? elem.getAttribute(site.attr) : shown)) elem.setAttribute(site.attr, text);
		return text;
	}
	const text = String(value);
	if (text === shown) return shown;
	const range = findMarkers(elem, site.markers[0], site.markers[1]);
	if (!range) return shown;
	// A text node, never markup: siblings are preserved and the value is not parsed.
	if (shown !== undefined || textBetween(range) !== text) replaceRange(range, elem.ownerDocument.createTextNode(text));
	return text;
}

// --- the shell --------------------------------------------------------------

/**
 * Base class of every generated shell (`BackflipMyWidget`). The subclass declares the
 * partial's attributes, the stores it reads and its root branch; the shell reads the
 * attributes off the element, puts them next to the stores, and hands every change to
 * the root patch-branch.
 */
export class BackflipShell {
	/** Each declared `b-attr`, and whether it is read as a string or a boolean. */
	static bfAttrs: Record<string, 'string' | 'bool'> = {};
	/** Each store the partial's patching reads, by name: the store file's default export. */
	static bfStores: Record<string, unknown> = {};
	static bfRoot: BranchDesc = { sites: [], sets: [] };

	ce: Element;
	pb: PatchBranch;

	constructor(ce: Element) {
		this.ce = ce;
		this.pb = new PatchBranch((this.constructor as typeof BackflipShell).bfRoot, ce, this.collectData());
	}

	collectData(): Data {
		const shell = this.constructor as typeof BackflipShell;
		const data: Data = { ...shell.bfStores };
		for (const [name, type] of Object.entries(shell.bfAttrs)) {
			data[name] = type === 'bool' ? this.ce.hasAttribute(name) : this.ce.getAttribute(name) ?? '';
		}
		return data;
	}

	/** Apply a change to attribute `name`, or, with no name, recompute everything. */
	update(name?: string): void {
		this.pb.update(this.collectData(), name);
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

	connectedCallback(): void {
		this.bfInit();
	}

	attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
		// setAttribute with an unchanged value still fires this. Before init there is
		// nothing to patch: init compares everything against the DOM.
		if (oldValue === newValue || !this.bfPatch) return;
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
		// Whatever changed since the server render, reported or not, is fixed here.
		this.bfPatch.update();
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
