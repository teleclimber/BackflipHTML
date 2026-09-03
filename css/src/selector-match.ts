import { compile as cssCompile } from 'css-select';
import { calculate } from 'specificity';
import type { CssRule, MatchedRule, ElementMatches } from './types.js';
import { tagNameOf, type AttrIndex, type ElementLikeTNode } from './tnode-view.js';
import {
	attrsOf, childrenOf, siblingsOf,
	type ExpandCtx, type InstanceForest, type InstanceNode,
} from './instance-tree.js';

// --- css-select adapter ---

/**
 * The adapter navigates the instance forest (see `instance-tree.ts`). Every
 * traversal goes through `childrenOf`, so a selector that reaches into a
 * partial — `:has()`, a descendant combinator — expands it on demand, and the
 * arrays handed to `getChildren` / `getSiblings` are the memoized ones
 * css-select needs for its identity scans.
 */
function makeAdapter(ctx: ExpandCtx) {
	const adapter = {
		isTag(node: InstanceNode): node is InstanceNode {
			return node != null;
		},

		getName(elem: InstanceNode): string {
			return tagNameOf(elem.tnode);
		},

		getAttributeValue(elem: InstanceNode, name: string): string | undefined {
			return attrsOf(elem).values.get(name.toLowerCase());
		},

		hasAttrib(elem: InstanceNode, name: string): boolean {
			return attrsOf(elem).values.has(name.toLowerCase());
		},

		getChildren(node: InstanceNode): InstanceNode[] {
			return childrenOf(node, ctx);
		},

		getParent(node: InstanceNode): InstanceNode | null {
			return node.parent;
		},

		getSiblings(node: InstanceNode): InstanceNode[] {
			return siblingsOf(node, ctx);
		},

		getText(_node: InstanceNode): string {
			// Template text is not modelled, so `:contains()` never matches.
			return '';
		},

		existsOne(test: (node: InstanceNode) => boolean, elems: InstanceNode[]): boolean {
			for (const el of elems) {
				if (test(el)) return true;
				if (adapter.existsOne(test, childrenOf(el, ctx))) return true;
			}
			return false;
		},

		findAll(test: (node: InstanceNode) => boolean, nodes: InstanceNode[]): InstanceNode[] {
			const result: InstanceNode[] = [];
			const walk = (list: InstanceNode[]): void => {
				for (const node of list) {
					if (test(node)) result.push(node);
					walk(childrenOf(node, ctx));
				}
			};
			walk(nodes);
			return result;
		},

		findOne(test: (node: InstanceNode) => boolean, elems: InstanceNode[]): InstanceNode | null {
			for (const el of elems) {
				if (test(el)) return el;
				const found = adapter.findOne(test, childrenOf(el, ctx));
				if (found) return found;
			}
			return null;
		},

		// Nothing calls `select()`: matching is `compile()` plus a per-instance
		// predicate, so subset removal never runs on a result set.
		removeSubsets(nodes: InstanceNode[]): InstanceNode[] {
			return nodes;
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

// --- Match types ---

function selectorUsesClass(selector: string): boolean {
	return /\.[\w-]/.test(selector);
}

function selectorUsesId(selector: string): boolean {
	return /#[\w-]/.test(selector);
}

/**
 * - `dynamic` — the selector keys off a class or id this element binds at
 *   runtime, so whether it matches is not knowable here. Checked first.
 * - `definite` — every instance of the element matched, and none of them was
 *   inside a `b-if` branch.
 * - `conditional` — anything else: matched in some instances but not all, or
 *   only under a branch that may not be taken.
 */
function matchTypeOf(
	attrs: AttrIndex,
	selector: string,
	hits: number,
	total: number,
	conditionalHit: boolean,
): 'definite' | 'conditional' | 'dynamic' {
	if ((attrs.dynamic.has('class') && selectorUsesClass(selector)) ||
		(attrs.dynamic.has('id') && selectorUsesId(selector))) {
		return 'dynamic';
	}
	if (hits === total && !conditionalHit) return 'definite';
	return 'conditional';
}

// --- Matching ---

/** One selector of one rule. The same selector text in two rules is two of these. */
interface Occurrence {
	rule: CssRule;
	selector: string;
	test: (node: InstanceNode) => boolean;
}

/** Everything the instances of one source TNode add up to. */
interface Accumulator {
	tnode: ElementLikeTNode;
	file: string;
	partialName: string;
	attrs: AttrIndex;
	total: number;
	hits: Map<Occurrence, { count: number; conditional: boolean }>;
}

/**
 * Match every rule against the render forest, reporting one entry per source
 * element. Counting hits against the element's instance total is what makes
 * `definite` mean "in every context", rather than "in the first context tried".
 */
export function matchSelectors(
	rules: CssRule[],
	forest: InstanceForest,
): Map<string, ElementMatches[]> {
	const result = new Map<string, ElementMatches[]>();

	// Selectors are compiled once per run. css-select's per-selector "this
	// ancestor did not match" cache is sound here because instances are
	// immutable for the life of the run — but only because the compiled
	// selectors die with it too, so nothing outlives the forest it cached.
	const adapterOpts = { adapter: makeAdapter(forest.ctx) as any };
	const compiled = new Map<string, ((node: InstanceNode) => boolean) | null>();
	const occurrences: Occurrence[] = [];
	const seen = new Set<string>();
	for (const rule of rules) {
		for (const selector of rule.selectors) {
			const key = `${selector}:${rule.sourceLine}:${rule.sourceCol}`;
			if (seen.has(key)) continue;
			seen.add(key);
			let test = compiled.get(selector);
			if (test === undefined) {
				try {
					test = cssCompile<InstanceNode, InstanceNode>(selector, adapterOpts);
				} catch {
					test = null;  // invalid selector: skip it, don't fail the run
				}
				compiled.set(selector, test);
			}
			if (test) occurrences.push({ rule, selector, test });
		}
	}
	if (occurrences.length === 0) return result;

	const accumulators = new Map<ElementLikeTNode, Accumulator>();
	for (const instance of forest.all) {
		let acc = accumulators.get(instance.tnode);
		if (!acc) {
			acc = {
				tnode: instance.tnode,
				file: instance.file,
				partialName: instance.partialName,
				attrs: attrsOf(instance),
				total: 0,
				hits: new Map(),
			};
			accumulators.set(instance.tnode, acc);
		}
		acc.total++;
		for (const occurrence of occurrences) {
			if (!occurrence.test(instance)) continue;
			let hit = acc.hits.get(occurrence);
			if (!hit) {
				hit = { count: 0, conditional: false };
				acc.hits.set(occurrence, hit);
			}
			hit.count++;
			if (instance.conditional) hit.conditional = true;
		}
	}

	for (const acc of accumulators.values()) {
		if (acc.hits.size === 0) continue;

		const matches: MatchedRule[] = [];
		for (const [occurrence, hit] of acc.hits) {
			matches.push({
				rule: occurrence.rule,
				selector: occurrence.selector,
				specificity: getSpecificity(occurrence.selector),
				mediaConditions: occurrence.rule.mediaConditions,
				matchType: matchTypeOf(acc.attrs, occurrence.selector, hit.count, acc.total, hit.conditional),
			});
		}
		matches.sort((a, b) => {
			for (let i = 0; i < 3; i++) {
				if (b.specificity[i] !== a.specificity[i]) return b.specificity[i] - a.specificity[i];
			}
			return 0;
		});

		const loc = acc.tnode.type === 'element' ? (acc.tnode.openTagLoc ?? acc.tnode.loc) : acc.tnode.loc;
		const entry: ElementMatches = {
			element: acc.tnode,
			file: acc.file,
			partialName: acc.partialName,
			startLine: loc?.startLine ?? 0,
			startCol: loc?.startCol ?? 0,
			startOffset: loc?.startOffset ?? 0,
			matches,
		};

		const existing = result.get(acc.file);
		if (existing) existing.push(entry);
		else result.set(acc.file, [entry]);
	}

	return result;
}
