import type {
	AttrPart, CustomElementCallTNode, ElementTNode, TNode,
} from '@backflip/html';

/**
 * The element view of the compiler's TNodes: which nodes render a tag, what tag
 * that is, and what attributes it carries.
 *
 * The compiler emits an element's attributes as `AttrPart`s — raw source text
 * for the static ones, a bare name for each runtime-bound one — rather than
 * name/value pairs. CSS needs the lookup. Nothing here copies the tree; the
 * nodes in it are the compiler's own, and can be reported directly as a match.
 *
 * Where those elements sit relative to each other is `instance-tree.ts`'s job.
 */

/** TNodes that render an element and can therefore match a CSS selector. */
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

// Cached by the identity of the AttrPart array: one element renders as many
// instances, and every one of them wants the same lookup.
const indexByParts = new WeakMap<AttrPart[], AttrIndex>();

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

/** Attribute lookup for a node, computed once per AttrPart array. */
export function attrIndexOf(node: ElementLikeTNode): AttrIndex {
	const parts = attrPartsOf(node);
	let index = indexByParts.get(parts);
	if (!index) {
		index = buildAttrIndex(parts);
		indexByParts.set(parts, index);
	}
	return index;
}
