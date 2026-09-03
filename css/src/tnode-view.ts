import type {
	AttrPart, CompiledFile, CustomElementCallTNode, ElementTNode, PartialRefTNode, TNode,
} from '@backflip/html';

/**
 * An element view over the compiler's TNode tree, for CSS selector matching.
 *
 * The compiler emits an *authoring* tree: `b-if` branches, `b-for` bodies and
 * `b-part` slot content are containers that render no element of their own, and
 * an element's attributes are `AttrPart`s (raw source text for the static ones,
 * a bare name for each runtime-bound one) rather than name/value pairs. CSS
 * needs the opposite shape — an element tree with parent/child links and an
 * attribute lookup. This module derives that view without copying the tree, so
 * every node in it is the compiler's own TNode and can be reported directly as
 * a match.
 *
 * The view is deliberately the same shape parse5 gave the analyzer before this
 * existed: elements only, with slot content appearing under the tag that
 * carries the `b-part` (where it is written), not where it renders. Where the
 * content *renders* is modelled separately, by context spines.
 */

/** TNodes that render as an element and can therefore match a CSS selector. */
export type ElementLikeTNode = ElementTNode | CustomElementCallTNode;

export function isElementLike(n: TNode): n is ElementLikeTNode {
	return n.type === 'element' || (n.type === 'partial-ref' && n.kind === 'custom-element');
}

/** The tag this node renders. For a custom-element call that is the partial name. */
export function tagNameOf(node: ElementLikeTNode): string {
	return node.type === 'element' ? node.tagName : (node.callerTagName ?? node.partialName);
}

/** The attr parts this node renders. For a custom-element call those are the call-site attrs. */
export function attrPartsOf(node: ElementLikeTNode): AttrPart[] {
	return node.type === 'element' ? node.attrs : (node.callerAttrs ?? []);
}

// --- Attributes ---

export interface AttrIndex {
	/** Attribute values known at compile time, by lowercased name. */
	values: Map<string, string>;
	/** Names bound at runtime (`b-bind:x` / `:x`), whose value is unknown. */
	dynamic: Set<string>;
}

// Cached by the identity of the AttrPart array: the same element is visited
// once per context spine, and a spine node shares its array with the element
// it stands in for.
const indexByParts = new WeakMap<AttrPart[], AttrIndex>();
// Set for synthesized nodes (spine ancestors), which carry no AttrParts.
const indexByNode = new WeakMap<ElementLikeTNode, AttrIndex>();

/**
 * Attribute name, optionally followed by a value: double-quoted, single-quoted,
 * or unquoted. Mirrors the HTML tokenizer closely enough for a static open-tag
 * fragment, which is all `AttrPart.raw` ever holds.
 */
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]*)))?/g;

/** Parse the attribute text of a static AttrPart (e.g. ` class="a b" hidden`) into `index`. */
export function parseStaticAttrs(raw: string, index: AttrIndex): void {
	for (const m of raw.matchAll(ATTR_RE)) {
		const name = m[1].toLowerCase();
		// Duplicate attributes: the first one wins, as in HTML parsing.
		if (index.values.has(name)) continue;
		index.values.set(name, m[2] ?? m[3] ?? m[4] ?? '');
	}
}

export function buildAttrIndex(parts: AttrPart[]): AttrIndex {
	const index: AttrIndex = { values: new Map(), dynamic: new Set() };
	for (const part of parts) {
		switch (part.type) {
			case 'static':
				parseStaticAttrs(part.raw, index);
				break;
			case 'dynamic':
				// Value computed at render time: known name, unknowable value.
				index.dynamic.add(part.name.toLowerCase());
				break;
			case 'asset':
				// `@name/...` reference; the source text is the best value we have
				// (resolveAssetRefs rewrites these into static parts for codegen).
				if (!index.values.has(part.attrName.toLowerCase())) {
					index.values.set(part.attrName.toLowerCase(), part.originalValue);
				}
				break;
		}
	}
	return index;
}

/** Attribute lookup for a node, computed once per AttrPart array (or per synthesized node). */
export function attrIndexOf(node: ElementLikeTNode): AttrIndex {
	const own = indexByNode.get(node);
	if (own) return own;
	const parts = attrPartsOf(node);
	let index = indexByParts.get(parts);
	if (!index) {
		index = buildAttrIndex(parts);
		indexByParts.set(parts, index);
	}
	return index;
}

/** Attach an attribute index to a synthesized node (see `makeSpineElement`). */
export function setAttrIndex(node: ElementLikeTNode, index: AttrIndex): void {
	indexByNode.set(node, index);
}

/** Build an index from already-parsed name/value pairs. */
export function attrIndexFromPairs(
	pairs: { name: string; value: string }[],
	dynamicAttrs: string[] = [],
): AttrIndex {
	const index: AttrIndex = { values: new Map(), dynamic: new Set() };
	for (const { name, value } of pairs) {
		const lower = name.toLowerCase();
		if (!index.values.has(lower)) index.values.set(lower, value);
	}
	for (const name of dynamicAttrs) index.dynamic.add(name.toLowerCase());
	return index;
}

// --- Element tree ---

export interface ElementView {
	/** Elements with no element ancestor inside this tree, in document order. */
	tops: ElementLikeTNode[];
	/** Every element in the tree, document order. These are the match candidates. */
	all: ElementLikeTNode[];
	/** Element parent, or null for a top. */
	parent: Map<ElementLikeTNode, ElementLikeTNode | null>;
	/** Element children, in document order. Stable arrays: css-select compares by identity. */
	children: Map<ElementLikeTNode, ElementLikeTNode[]>;
	/** Elements that render only in some `b-if` / `b-else-if` / `b-else` branch. */
	conditional: Set<ElementLikeTNode>;
}

/**
 * Build the element view of a list of TNodes (a partial root's `tnodes`, or one
 * slot's content).
 *
 * Containers that render no tag of their own are transparent: `b-for` bodies,
 * `b-if` branches (every branch is walked, and the elements directly inside one
 * are marked conditional), and the slots of a `b-part` call — for a `b-part` the
 * caller's tree only ever contained the slot content, the target partial's own
 * body being analysed separately under its own context spines. A custom-element
 * call *does* render a tag, so it is an element here, with its slot content as
 * its children.
 */
export function buildElementView(roots: TNode[]): ElementView {
	const parent = new Map<ElementLikeTNode, ElementLikeTNode | null>();
	const children = new Map<ElementLikeTNode, ElementLikeTNode[]>();
	const conditional = new Set<ElementLikeTNode>();
	const all: ElementLikeTNode[] = [];

	function slotElements(ref: PartialRefTNode, cond: boolean): ElementLikeTNode[] {
		const out: ElementLikeTNode[] = [];
		for (const slotNodes of Object.values(ref.slots)) out.push(...collect(slotNodes, cond));
		return out;
	}

	function register(el: ElementLikeTNode, kids: ElementLikeTNode[]): void {
		children.set(el, kids);
		for (const kid of kids) parent.set(kid, el);
	}

	function collect(tnodes: TNode[], cond: boolean): ElementLikeTNode[] {
		const out: ElementLikeTNode[] = [];
		for (const n of tnodes) {
			switch (n.type) {
				case 'element':
					out.push(n);
					all.push(n);
					if (cond) conditional.add(n);
					// An element boundary resets conditionality: only the tag that
					// carries the b-if is conditional, not everything under it.
					register(n, collect(n.tnodes, false));
					break;
				case 'partial-ref':
					if (n.kind === 'custom-element') {
						out.push(n);
						all.push(n);
						if (cond) conditional.add(n);
						register(n, slotElements(n, false));
					} else {
						out.push(...slotElements(n, cond));
					}
					break;
				case 'if':
					for (const branch of n.branches) out.push(...collect(branch.tnodes, true));
					break;
				case 'for':
					out.push(...collect(n.tnodes, cond));
					break;
				// raw / comment / print / slot / attr-bind render no element
			}
		}
		return out;
	}

	const tops = collect(roots, false);
	for (const top of tops) parent.set(top, null);
	return { tops, all, parent, children, conditional };
}

// --- Locating compiled nodes for a source position ---

/** Every `b-part` call in a compiled file, with the source offset of its `b-part` value. */
export function collectBPartRefs(file: CompiledFile): { ref: PartialRefTNode; offset: number }[] {
	const found: { ref: PartialRefTNode; offset: number }[] = [];
	function walk(tnodes: TNode[]): void {
		for (const n of tnodes) {
			switch (n.type) {
				case 'partial-ref':
					if (n.kind === 'b-part' && n.loc) found.push({ ref: n, offset: n.loc.startOffset });
					for (const slotNodes of Object.values(n.slots)) walk(slotNodes);
					break;
				case 'element':
				case 'for':
					walk(n.tnodes);
					break;
				case 'if':
					for (const branch of n.branches) walk(branch.tnodes);
					break;
			}
		}
	}
	for (const root of file.partials.values()) walk(root.tnodes);
	return found;
}

/**
 * The `b-part` call written inside the open tag spanning [startOffset, endOffset).
 *
 * A `b-part` ref's `loc` is the location of the directive's value, which is
 * always inside the open tag of the tag carrying it — the one the DOM-side
 * usage graph reports. Nested calls start later in the file, so the earliest
 * ref in range is the one that belongs to this tag.
 */
export function findBPartRefInRange(
	refs: { ref: PartialRefTNode; offset: number }[],
	startOffset: number,
	endOffset: number,
	partialName: string,
): PartialRefTNode | null {
	let best: { ref: PartialRefTNode; offset: number } | null = null;
	for (const candidate of refs) {
		if (candidate.offset < startOffset || candidate.offset >= endOffset) continue;
		if (candidate.ref.partialName !== partialName) continue;
		if (!best || candidate.offset < best.offset) best = candidate;
	}
	return best?.ref ?? null;
}
