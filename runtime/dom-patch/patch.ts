/// <reference lib="dom" />
// Browser-side runtime imported by generated dom-patch modules. A module describes
// its partial's patchable sites as data; this file does the patching.

import { render, activeBranchIndex, attrIsRendered, execFn, forItemCtx, type rfn, type ForRNode, type IfRNode } from '../js/render.js';
import { enqueue, FLUSH_EVENT, register } from './flush.js';

/**
 * Replace everything between two marker comments among `children`, by default all of
 * `parent`'s direct children, with `node`. The markers themselves survive, so the
 * range stays patchable. Returns whether the markers were found.
 */
export function replaceBetween(parent: Node, startMarker: string, endMarker: string, node: Node, children?: ChildNode[]): boolean {
	const range = findMarkers(parent, startMarker, endMarker, children);
	if (range) replaceRange(range, node);
	return range !== null;
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

// The two marker comments among `children`. Missing or repeated ones mean the rendered
// DOM diverged from the compiled template, so they are reported against `parent`.
function findMarkers(parent: Node, startMarker: string, endMarker: string, children: ChildNode[] = Array.from(parent.childNodes)): [ChildNode, ChildNode] | null {
	const comments = children.filter(child => child.nodeType === 8);
	const starts = comments.filter(c => c.nodeValue === startMarker);
	const ends = comments.filter(c => c.nodeValue === endMarker);
	if (starts.length === 1 && ends.length === 1) return [starts[0], ends[0]];
	const problem = starts.length > 1 || ends.length > 1 ? 'found more than once' : 'not found';
	console.error(`BackflipHTML: comment markers ${startMarker} / ${endMarker} ${problem}`, parent);
	return null;
}

// The index of the branch rendered between a set's markers, from the branch marker
// that opens it; -1 when none is there.
function renderedBranchIndex(parent: Node, desc: SetDesc, children: ChildNode[]): number {
	const range = findMarkers(parent, desc.markers[0], desc.markers[1], children);
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
 * A `b-if` set: re-rendered from `snapshot` between its markers when its winning
 * branch changes.
 */
export interface SetDesc {
	bfid: string | null;
	markers: [string, string];
	snapshot: IfRNode;
	/** Index-aligned with the snapshot's branches; null for a branch with nothing to patch. */
	branches: (BranchDesc | null)[];
	/**
	 * Index-aligned with the snapshot's branches: the comment that opens each branch's
	 * content, so the DOM shows which branch is rendered.
	 */
	branchMarkers: string[];
}

/**
 * A `b-for` loop: each item between its markers is a patch-branch of its own, matched
 * to its data by key.
 */
export interface LoopDesc {
	bfid: string | null;
	markers: [string, string];
	/** The comment that opens each item, which is the first of the snapshot's nodes. */
	itemMarker: string;
	/** The iterable and loop names, and the nodes an added item is rendered from. */
	snapshot: ForRNode;
	key: rfn;
	/** What each item patches. Items share it. */
	item: BranchDesc;
}

/** A subtree that is wholly present or wholly absent: its own sites, and the sets and loops it owns. */
export interface BranchDesc {
	sites: SiteDesc[];
	sets: SetDesc[];
	loops?: LoopDesc[];
}

/**
 * The nodes of one `b-for` item among its parent's children: from the comment that
 * opens it up to the next item's opening comment or the loop's end marker.
 */
export interface ItemRange {
	start: ChildNode;
	itemMarker: string;
	endMarker: string;
}

// An item's nodes, worked out from its opening comment, which moves with the item.
function itemNodes({ start, itemMarker, endMarker }: ItemRange): ChildNode[] {
	const nodes: ChildNode[] = [];
	for (let n = start.nextSibling; n; n = n.nextSibling) {
		if (n.nodeType === 8 && (n.nodeValue === itemMarker || n.nodeValue === endMarker)) break;
		nodes.push(n);
	}
	return nodes;
}

function itemWithMarker(range: ItemRange): ChildNode[] {
	return [range.start, ...itemNodes(range)];
}

// --- patching ---------------------------------------------------------------

type Data = Record<string, unknown>;

/** What a site shows in the DOM: its text, or for an attr `false` when absent and, for a bool attr, `true` when present. */
type Shown = string | boolean;

interface SetState {
	desc: SetDesc;
	/** The winning branch index, or -1 when none matches. */
	active: number;
	/** Patch-branch per branch index, created when that branch is rendered. */
	children: Map<number, PatchBranch>;
}

type LoopKey = string | number;

interface LoopState {
	desc: LoopDesc;
	/** Each item's patch-branch by key; null when the rendered items could not be paired with the data. */
	items: Map<LoopKey, PatchBranch> | null;
}

interface LoopItem {
	key: LoopKey;
	ctx: Data;
}

// Parse HTML against the element it will go in, so it gets its real parent context (a
// <tr> under a <tbody> survives).
function parseIn(elem: Element, html: string): DocumentFragment {
	const range = elem.ownerDocument.createRange();
	range.selectNodeContents(elem);
	return range.createContextualFragment(html);
}

// moveBefore keeps focus, iframes and animations through the move, where the browser has it.
function moveNode(parent: Element, node: ChildNode, before: ChildNode): void {
	const p = parent as Element & { moveBefore?: (node: Node, child: Node | null) => void };
	if (p.moveBefore) p.moveBefore(node, before);
	else parent.insertBefore(node, before);
}

// A loop's items for `data`, each with its key and context. Anything that keeps them
// from being told apart is reported, and null returned.
function loopItems(desc: LoopDesc, data: Data, elem: Element): LoopItem[] | null {
	try {
		const list = execFn(desc.snapshot.iterable, data);
		if (!Array.isArray(list)) {
			throw new Error(`b-for iterates over ${list === null ? 'null' : typeof list}; only an array can be patched`);
		}
		const seen = new Set<LoopKey>();
		return list.map((item, index) => {
			const ctx = forItemCtx(desc.snapshot, data, item, index);
			const key = execFn(desc.key, ctx);
			if (typeof key !== 'string' && !Number.isFinite(key)) throw new Error(`b-key must be a string or a number, got ${String(key)}`);
			if (seen.has(key)) throw new Error(`b-key ${JSON.stringify(key)} is not unique in the list`);
			seen.add(key);
			return { key, ctx };
		});
	} catch (e) {
		console.error('BackflipHTML: b-for not updated', e, elem);
		return null;
	}
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
	/** The custom element this branch belongs to. */
	owner: Element;
	/** The `b-for` item this branch is limited to, among `refElem`'s children. */
	range?: ItemRange;
	sets: SetState[];
	loops: LoopState[];
	/** What each site shows, index-aligned with `desc.sites`; undefined until read from the DOM. */
	shown: (Shown | undefined)[];

	constructor(desc: BranchDesc, refElem: Element, data: Data, owner: Element = refElem, range?: ItemRange) {
		this.desc = desc;
		this.refElem = refElem;
		this.owner = owner;
		this.range = range;
		this.shown = desc.sites.map(() => undefined);
		this.sets = desc.sets.map(d => {
			const elem = this.target(d.bfid);
			return {
				desc: d,
				active: elem ? renderedBranchIndex(elem, d, this.children(elem)) : -1,
				children: new Map(),
			};
		});
		for (const s of this.sets) this.createChild(s, s.active, data);
		this.loops = (desc.loops ?? []).map(d => ({ desc: d, items: this.pairItems(d, data) }));
	}

	/**
	 * Evaluate everything this branch owns and write what differs. Sets run first: a
	 * re-render replaces whole subtrees, so this branch's own sites are patched against
	 * the DOM that results. A set that keeps its branch updates that branch instead.
	 */
	update(data: Data): void {
		for (const s of this.sets) {
			if (!this.renderIf(s, data)) s.children.get(s.active)?.update(data);
		}
		for (const l of this.loops) this.updateLoop(l, data);
		this.desc.sites.forEach((site, i) => {
			const next = this.shownValue(site, data);
			if (next === this.shown[i]) return;
			const elem = this.target(site.bfid);
			if (elem) this.shown[i] = writeSite(elem, site, next, this.shown[i], this.children(elem));
		});
	}

	// What the site should show for `data`. An expression that throws, such as a lookup
	// of a removed entry, shows as empty and is evaluated again on the next update.
	shownValue(site: SiteDesc, data: Data): Shown {
		let value: unknown = '';
		try {
			value = execFn(site.expr, data);
		} catch (e) {
			console.error('BackflipHTML: expression failed; showing an empty value', e, this.refElem);
		}
		if (!('attr' in site)) return String(value);
		if (site.bool) return Boolean(value);
		return attrIsRendered(value) ? String(value) : false;
	}

	// Swap in the winning branch if it changed; returns whether it did. An expression
	// that throws keeps the current branch.
	renderIf(s: SetState, data: Data): boolean {
		let idx: number, html: string;
		try {
			idx = activeBranchIndex(s.desc.snapshot, data);
			if (idx === s.active) return false;
			html = render(s.desc.snapshot, data);
		} catch (e) {
			console.error('BackflipHTML: b-if expression failed; keeping the current branch', e, this.refElem);
			return false;
		}
		const elem = this.target(s.desc.bfid);
		if (!elem) return false;
		if (!replaceBetween(elem, s.desc.markers[0], s.desc.markers[1], parseIn(elem, html), this.children(elem))) return false;
		s.children.delete(s.active);
		s.active = idx;
		this.createChild(s, idx, data);
		return true;
	}

	createChild(s: SetState, idx: number, data: Data): void {
		const desc = s.desc.branches[idx];
		if (!desc || s.children.has(idx)) return;
		const elem = this.target(s.desc.bfid);
		if (elem) s.children.set(idx, new PatchBranch(desc, elem, data, this.owner, elem === this.refElem ? this.range : undefined));
	}

	// Pair each rendered item with its data: `data` is what was rendered, so the Nth key
	// belongs to the Nth item marker. A mismatch means the DOM diverged from the data;
	// it is reported and the loop stays as rendered.
	pairItems(d: LoopDesc, data: Data): Map<LoopKey, PatchBranch> | null {
		const elem = this.target(d.bfid);
		const range = elem && findMarkers(elem, d.markers[0], d.markers[1], this.children(elem));
		if (!elem || !range) return null;
		const items = loopItems(d, data, elem);
		if (!items) return null;
		const markers: ChildNode[] = [];
		for (let n = range[0].nextSibling; n && n !== range[1]; n = n.nextSibling) {
			if (n.nodeType === 8 && n.nodeValue === d.itemMarker) markers.push(n);
		}
		if (markers.length !== items.length) {
			console.error(`BackflipHTML: b-for rendered ${markers.length} items but the data has ${items.length}; skipping updates`, elem);
			return null;
		}
		return new Map(items.map(({ key, ctx }, i) => {
			const itemRange = { start: markers[i], itemMarker: d.itemMarker, endMarker: d.markers[1] };
			return [key, new PatchBranch(d.item, elem, ctx, this.owner, itemRange)];
		}));
	}

	// Bring the items in line with the keys `data` gives, then update each with its data.
	updateLoop(l: LoopState, data: Data): void {
		if (!l.items) return;
		const next = loopItems(l.desc, data, this.refElem);
		if (!next) return;
		const current = [...l.items.keys()];
		const sameKeys = next.length === current.length && next.every(({ key }, i) => key === current[i]);
		if (!sameKeys && !this.reconcileItems(l, next)) return;
		for (const { key, ctx } of next) l.items.get(key)!.update(ctx);
	}

	// Remove the items whose keys are gone, then walk the new order with a cursor at the
	// position being filled: an item already there stays untouched, a kept item elsewhere
	// has its nodes moved there, and a new key is rendered there. Returns whether it ran.
	reconcileItems(l: LoopState, next: LoopItem[]): boolean {
		const d = l.desc;
		const elem = this.target(d.bfid);
		const range = elem && findMarkers(elem, d.markers[0], d.markers[1], this.children(elem));
		if (!elem || !range) return false;

		// Rendered ahead of any change, so a render that throws leaves the DOM as it was.
		const added = new Map<LoopKey, DocumentFragment>();
		try {
			for (const { key, ctx } of next) {
				if (!l.items!.has(key)) added.set(key, parseIn(elem, d.snapshot.nodes.map(n => render(n, ctx)).join('')));
			}
		} catch (e) {
			console.error('BackflipHTML: b-for item failed to render; not updating the list', e, elem);
			return false;
		}

		const keep = new Set(next.map(({ key }) => key));
		for (const [key, branch] of l.items!) {
			if (!keep.has(key)) for (const n of itemWithMarker(branch.range!)) n.remove();
		}

		const items = new Map<LoopKey, PatchBranch>();
		let cursor = range[0].nextSibling!;
		for (const { key, ctx } of next) {
			const fragment = added.get(key);
			if (fragment) {
				const start = fragment.firstChild!;
				elem.insertBefore(fragment, cursor);
				items.set(key, new PatchBranch(d.item, elem, ctx, this.owner, { start, itemMarker: d.itemMarker, endMarker: d.markers[1] }));
				continue;
			}
			const branch = l.items!.get(key)!;
			const nodes = itemWithMarker(branch.range!);
			if (nodes[0] === cursor) cursor = nodes[nodes.length - 1].nextSibling!;
			else for (const n of nodes) moveNode(elem, n, cursor);
			items.set(key, branch);
		}
		l.items = items;
		return true;
	}

	// The children of `elem` this branch owns: only its item's when `elem` is the parent
	// the item shares with its siblings.
	children(elem: Element): ChildNode[] {
		return this.range && elem === this.refElem ? itemNodes(this.range) : Array.from(elem.childNodes);
	}

	// The elements with a data-bfid that this branch can see.
	withBfid(bfid: string): Element[] {
		const selector = `[data-bfid="${bfid}"]`;
		if (!this.range) return Array.from(this.refElem.querySelectorAll(selector));
		return itemNodes(this.range)
			.filter((n): n is ChildNode & Element => n.nodeType === 1)
			.flatMap(n => [...(n.matches(selector) ? [n] : []), ...n.querySelectorAll(selector)]);
	}

	// The element a site or set is anchored to. A missing or duplicated one means the
	// rendered DOM diverged from the compiled template, so it is reported and not patched
	target(bfid: string | null): Element | null {
		if (bfid === null) return this.refElem;
		// Instances of a partial share their data-bfids, and slot content can put another
		// instance ahead of this one's own elements.
		const own = this.withBfid(bfid).filter(elem => nearestOfSameTag(elem, this.owner) === this.owner);
		if (own.length === 1) return own[0];
		if (own.length === 0) console.error(`BackflipHTML: element [data-bfid="${bfid}"] not found; skipping update`, this.refElem);
		else console.error(`BackflipHTML: ${own.length} elements have [data-bfid="${bfid}"]; skipping update`, own);
		return null;
	}
}

// The closest ancestor of `elem` with the same tag as `owner`.
function nearestOfSameTag(elem: Element, owner: Element): Element | null {
	for (let p = elem.parentElement; p; p = p.parentElement) {
		if (p.localName === owner.localName) return p;
	}
	return null;
}

// Write `next` unless the DOM already shows it, reading what it shows when `shown` is
// undefined. Returns what the site shows afterwards.
function writeSite(elem: Element, site: SiteDesc, next: Shown, shown: Shown | undefined, children: ChildNode[]): Shown | undefined {
	if ('attr' in site) {
		const current = shown ?? (site.bool ? elem.hasAttribute(site.attr) : elem.getAttribute(site.attr) ?? false);
		if (next === current) return next;
		if (next === false) elem.removeAttribute(site.attr);
		else elem.setAttribute(site.attr, next === true ? '' : next);
		return next;
	}
	const range = findMarkers(elem, site.markers[0], site.markers[1], children);
	if (!range) return shown;
	// A text node, never markup: siblings are preserved and the value is not parsed.
	if (shown !== undefined || textBetween(range) !== next) replaceRange(range, elem.ownerDocument.createTextNode(String(next)));
	return next;
}

// --- the shell --------------------------------------------------------------

/**
 * Base class of every generated shell (`BackflipMyWidget`). The subclass declares the
 * partial's attributes, the stores it reads and its root branch; the shell reads the
 * attributes off the element, puts them next to the stores, and updates the root
 * patch-branch when a flush reaches it and any of them differ from what it last rendered.
 */
export class BackflipShell {
	/** Each declared `b-attr`, and whether it is read as a string or a boolean. */
	static bfAttrs: Record<string, 'string' | 'bool'> = {};
	/** Each store the partial's patching reads, by name: the store file's default export. */
	static bfStores: Record<string, { data: unknown }> = {};
	static bfRoot: BranchDesc = { sites: [], sets: [] };

	ce: Element;
	pb: PatchBranch;
	/** The value last rendered for each attribute, and the `data` for each store. */
	rendered: Data;

	/** Patches the DOM right away, from the current attributes and store data. */
	constructor(ce: Element) {
		this.ce = ce;
		const shell = this.constructor as typeof BackflipShell;
		const data = this.collectData();
		this.pb = new PatchBranch(shell.bfRoot, ce, data);
		this.rendered = this.readInputs();
		// Capture, so ancestors sync before the element the event was dispatched on.
		ce.addEventListener(FLUSH_EVENT, () => this.sync(), { capture: true });
		for (const store of Object.values(shell.bfStores)) register(store, ce);
		this.pb.update(data);
	}

	collectData(): Data {
		const shell = this.constructor as typeof BackflipShell;
		const data: Data = { ...shell.bfStores };
		for (const [name, type] of Object.entries(shell.bfAttrs)) {
			data[name] = type === 'bool' ? this.ce.hasAttribute(name) : this.ce.getAttribute(name) ?? '';
		}
		return data;
	}

	// The data with each store replaced by its current `data`, whose identity changes
	// when the store does.
	readInputs(): Data {
		const inputs = this.collectData();
		const { bfStores } = this.constructor as typeof BackflipShell;
		for (const [name, store] of Object.entries(bfStores)) inputs[name] = store.data;
		return inputs;
	}

	/** Have the next flush bring the DOM up to date. */
	update(): void {
		enqueue(this.ce);
	}

	sync(): void {
		// An ancestor's patch can remove the element after its event was dispatched. The
		// recorded values stay, so it catches up if it is connected again.
		if (!this.ce.isConnected) return;
		const inputs = this.readInputs();
		const changed = Object.keys(inputs).some(name => inputs[name] !== this.rendered[name]);
		this.rendered = inputs;
		if (changed) this.pb.update(this.collectData());
	}
}

// --- the custom element -----------------------------------------------------

// Resolved at load, so this module can also be imported where there is no DOM.
const ElementBase = (globalThis.HTMLElement ?? class {}) as typeof HTMLElement;

/**
 * Base class of every generated custom element class. The generated subclass sets
 * `bfShell`; this class observes the shell's declared attributes, runs the lifecycle
 * and tells the shell about attribute changes and reconnects.
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
		// An element connected again syncs with whatever changed while it was out.
		if (this.bfPatch) this.bfPatch.update();
		else this.bfInit();
	}

	attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
		// setAttribute with an unchanged value still fires this. Before init there is
		// nothing to patch: init compares everything against the DOM. A subclass may
		// observe attributes the partial does not read.
		if (oldValue === newValue || !this.bfPatch) return;
		const { bfShell } = this.constructor as typeof BackflipElement;
		if (bfShell && Object.hasOwn(bfShell.bfAttrs, name)) this.bfPatch.update();
	}

	// Idempotent, since an element connected mid-parse waits for the document and may
	// be moved before it finishes.
	bfInit(): void {
		if (this.bfPatch) return;
		if (this.ownerDocument.readyState === 'loading') {
			// Connected by the parser: our children are not all here yet.
			this.ownerDocument.addEventListener('DOMContentLoaded', () => this.bfInit(), { once: true });
			return;
		}
		this.bfCheckObserved();
		const cls = this.constructor as typeof BackflipElement;
		// Whatever changed since the server render, reported or not, is fixed here.
		this.bfPatch = new cls.bfShell!(this);
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
