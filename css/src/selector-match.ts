import { compile as cssCompile } from 'css-select';
import { calculate } from 'specificity';
import type { TNode, ElementTNode } from '@backflip/html';
import type {
	CssRule, MatchedRule, ElementMatches, SpineNode, ContextSpine,
} from './types.js';
import {
	attrIndexFromPairs, attrIndexOf, buildElementView, setAttrIndex, tagNameOf,
	type ElementLikeTNode, type ElementView,
} from './tnode-view.js';

// --- Navigation ---

/**
 * Parent/child navigation for one subtree grafted onto one context spine.
 *
 * The subtree's own links come from its `ElementView` and are shared by every
 * spine; the spine chain is synthesized per graft. Child arrays are stable
 * objects because css-select locates an element among its siblings by identity
 * (`equals` in `general.js`, a raw `indexOf` in `subselects.js`).
 */
interface Nav {
	parentOf(node: ElementLikeTNode): ElementLikeTNode | null;
	childrenOf(node: ElementLikeTNode): ElementLikeTNode[];
	siblingsOf(node: ElementLikeTNode): ElementLikeTNode[];
}

/**
 * A stand-in element for one spine ancestor.
 *
 * Spine ancestors are DOM-side descriptions of where a partial renders, so they
 * carry name/value attribute pairs rather than AttrParts; the index is attached
 * directly. A fresh node per graft keeps identity per spine, so nothing a
 * selector concluded under one spine can leak into another.
 */
function makeSpineElement(spine: SpineNode): ElementTNode {
	const el: ElementTNode = { type: 'element', tagName: spine.tagName, attrs: [], tnodes: [] };
	setAttrIndex(el, attrIndexFromPairs(spine.attrs, spine.dynamicAttrs));
	return el;
}

/** Hang `view`'s top elements off a chain of spine ancestors, outermost first. */
function graftOntoSpine(view: ElementView, spine: ContextSpine): Nav {
	const chain = spine.ancestors.map(makeSpineElement);
	const spineParent = new Map<ElementLikeTNode, ElementLikeTNode | null>();
	const spineChildren = new Map<ElementLikeTNode, ElementLikeTNode[]>();
	for (let i = 0; i < chain.length; i++) {
		spineParent.set(chain[i], i === 0 ? null : chain[i - 1]);
		spineChildren.set(chain[i], i === chain.length - 1 ? view.tops : [chain[i + 1]]);
	}
	const graftPoint = chain.length > 0 ? chain[chain.length - 1] : null;

	const parentOf = (node: ElementLikeTNode): ElementLikeTNode | null => {
		if (spineParent.has(node)) return spineParent.get(node)!;
		// A top of the subtree maps to null in the view; under a spine its parent
		// is the innermost ancestor.
		return view.parent.get(node) ?? graftPoint;
	};
	const childrenOf = (node: ElementLikeTNode): ElementLikeTNode[] =>
		spineChildren.get(node) ?? view.children.get(node) ?? [];
	const siblingsOf = (node: ElementLikeTNode): ElementLikeTNode[] => {
		const parent = parentOf(node);
		if (parent) return childrenOf(parent);
		return spineParent.has(node) ? [node] : view.tops;
	};
	return { parentOf, childrenOf, siblingsOf };
}

// --- css-select adapter ---

/**
 * The adapter reads whichever graft is being matched right now. Selectors are
 * compiled once per `matchSelectors` call and reused across every spine, so the
 * navigation they see has to be swappable.
 */
function makeAdapter(getNav: () => Nav) {
	const isTag = (node: ElementLikeTNode): node is ElementLikeTNode => node != null;

	const adapter = {
		isTag,

		existsOne(test: (node: ElementLikeTNode) => boolean, elems: ElementLikeTNode[]): boolean {
			for (const el of elems) {
				if (test(el)) return true;
				if (adapter.existsOne(test, getNav().childrenOf(el))) return true;
			}
			return false;
		},

		getAttributeValue(elem: ElementLikeTNode, name: string): string | undefined {
			return attrIndexOf(elem).values.get(name.toLowerCase());
		},

		getChildren(node: ElementLikeTNode): ElementLikeTNode[] {
			return getNav().childrenOf(node);
		},

		getName(elem: ElementLikeTNode): string {
			return tagNameOf(elem);
		},

		getParent(node: ElementLikeTNode): ElementLikeTNode | null {
			return getNav().parentOf(node);
		},

		getSiblings(node: ElementLikeTNode): ElementLikeTNode[] {
			return getNav().siblingsOf(node);
		},

		getText(_node: ElementLikeTNode): string {
			// Template text is not modelled, so `:contains()` never matches.
			return '';
		},

		hasAttrib(elem: ElementLikeTNode, name: string): boolean {
			return attrIndexOf(elem).values.has(name.toLowerCase());
		},

		removeSubsets(nodes: ElementLikeTNode[]): ElementLikeTNode[] {
			const nav = getNav();
			const result: ElementLikeTNode[] = [];
			for (const node of nodes) {
				let dominated = false;
				for (const other of nodes) {
					if (node === other) continue;
					let parent = nav.parentOf(node);
					while (parent) {
						if (parent === other) { dominated = true; break; }
						parent = nav.parentOf(parent);
					}
					if (dominated) break;
				}
				if (!dominated) result.push(node);
			}
			return result;
		},

		findAll(test: (node: ElementLikeTNode) => boolean, nodes: ElementLikeTNode[]): ElementLikeTNode[] {
			const result: ElementLikeTNode[] = [];
			const walk = (list: ElementLikeTNode[]) => {
				for (const node of list) {
					if (test(node)) result.push(node);
					walk(getNav().childrenOf(node));
				}
			};
			walk(nodes);
			return result;
		},

		findOne(test: (node: ElementLikeTNode) => boolean, elems: ElementLikeTNode[]): ElementLikeTNode | null {
			for (const el of elems) {
				if (test(el)) return el;
				const found = adapter.findOne(test, getNav().childrenOf(el));
				if (found) return found;
			}
			return null;
		},
	};
	return adapter;
}

// --- Specificity ---

const specificityCache = new Map<string, [number, number, number]>();

function getSpecificity(selector: string): [number, number, number] {
	let cached = specificityCache.get(selector);
	if (cached) return cached;
	const result = calculate(selector);
	cached = [result.A, result.B, result.C];
	specificityCache.set(selector, cached);
	return cached;
}

// --- Selector uses class/id check ---

function selectorUsesClass(selector: string): boolean {
	return /\.[\w-]/.test(selector);
}

function selectorUsesId(selector: string): boolean {
	return /#[\w-]/.test(selector);
}

// --- Main matching ---

function determineMatchType(
	node: ElementLikeTNode,
	view: ElementView,
	spine: ContextSpine,
	selector: string,
): 'definite' | 'conditional' | 'dynamic' {
	// Check dynamic: does selector reference class/id and the element has dynamic class/id?
	const dynamic = attrIndexOf(node).dynamic;
	if ((dynamic.has('class') && selectorUsesClass(selector)) ||
		(dynamic.has('id') && selectorUsesId(selector))) {
		return 'dynamic';
	}

	// Check conditional: the element itself, or any ancestor, is in a b-if branch
	if (spine.isConditional || view.conditional.has(node)) {
		return 'conditional';
	}

	return 'definite';
}

export interface MatchRoots {
	/** The TNodes to match against: a partial root's `tnodes`, or one slot's content. */
	roots: TNode[];
	file: string;
	partialName: string;
}

export function matchSelectors(
	rules: CssRule[],
	partialRoots: Map<string, MatchRoots>,
	spinesCache: Map<string, ContextSpine[]>,
): Map<string, ElementMatches[]> {
	const result = new Map<string, ElementMatches[]>();

	let nav: Nav | null = null;
	const adapter = makeAdapter(() => nav!);

	// Pre-compile all selectors once. `cacheResults: false` disables css-select's
	// per-selector "this ancestor did not match" WeakSet: the same TNode is
	// matched under several spines, so an ancestor verdict is not stable across
	// calls the way it is for a fixed DOM.
	const adapterOpts = { adapter: adapter as any, cacheResults: false };
	const compiledSelectors = new Map<string, (node: ElementLikeTNode) => boolean>();
	for (const rule of rules) {
		for (const selector of rule.selectors) {
			if (!compiledSelectors.has(selector)) {
				try {
					const compiled = cssCompile<ElementLikeTNode, ElementLikeTNode>(selector, adapterOpts);
					compiledSelectors.set(selector, compiled);
				} catch {
					// Skip invalid selectors
				}
			}
		}
	}

	for (const [key, partial] of partialRoots) {
		const spines = spinesCache.get(key) ?? [{ ancestors: [], isConditional: false }];

		// The element view is spine-independent: only the graft point changes.
		const view = buildElementView(partial.roots);
		if (view.all.length === 0) continue;

		// Per-element match accumulator, keyed by the compiler's own TNode.
		const elementMatchMap = new Map<ElementLikeTNode, { seen: Set<string>; matches: MatchedRule[] }>();

		for (const spine of spines) {
			nav = graftOntoSpine(view, spine);

			for (const node of view.all) {
				let entry = elementMatchMap.get(node);
				if (!entry) {
					entry = { seen: new Set(), matches: [] };
					elementMatchMap.set(node, entry);
				}

				for (const rule of rules) {
					for (const selector of rule.selectors) {
						const matchKey = `${selector}:${rule.sourceLine}:${rule.sourceCol}`;
						if (entry.seen.has(matchKey)) continue;

						const compiled = compiledSelectors.get(selector);
						if (compiled && compiled(node)) {
							entry.seen.add(matchKey);
							entry.matches.push({
								rule,
								selector,
								specificity: getSpecificity(selector),
								mediaConditions: rule.mediaConditions,
								matchType: determineMatchType(node, view, spine, selector),
							});
						}
					}
				}
			}
		}

		// Convert accumulated matches to result
		for (const [node, { matches }] of elementMatchMap) {
			if (matches.length === 0) continue;

			matches.sort((a, b) => {
				for (let i = 0; i < 3; i++) {
					if (b.specificity[i] !== a.specificity[i]) {
						return b.specificity[i] - a.specificity[i];
					}
				}
				return 0;
			});

			const loc = node.type === 'element' ? (node.openTagLoc ?? node.loc) : node.loc;
			const entry: ElementMatches = {
				element: node,
				file: partial.file,
				partialName: partial.partialName,
				startLine: loc?.startLine ?? 0,
				startCol: loc?.startCol ?? 0,
				startOffset: loc?.startOffset ?? 0,
				matches,
			};

			const existing = result.get(partial.file);
			if (existing) {
				existing.push(entry);
			} else {
				result.set(partial.file, [entry]);
			}
		}
	}

	return result;
}
