import { compile as cssCompile } from 'css-select';
import { calculate } from 'specificity';
import type { AnalysisFailure, CssRule, MatchedRule, ElementMatches, SelectorLoc } from './types.js';
import { relaxSelector, type StrippedPseudo } from './relax-selector.js';
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
	return {
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

		// Nothing calls `select()`: matching is `compile()` plus a per-instance
		// predicate, so subset removal never runs on a result set.
		removeSubsets(nodes: InstanceNode[]): InstanceNode[] {
			return nodes;
		},
	};
}

/** A selector ready to run: the predicate, and what had to come off to get it. */
export interface CompiledSelector {
	/** Matches one instance. Built from the *relaxed* selector text. */
	test: (node: InstanceNode) => boolean;
	/** Pseudos removed before compiling. Empty when the selector compiled as authored. */
	strippedPseudos: StrippedPseudo[];
}

/**
 * Compile one selector against a forest, returning a predicate over its
 * instances — or null if it is not a selector this matcher can read.
 *
 * The selector is relaxed first (see `relax-selector.ts`): the pseudos Backflip
 * cannot answer come off, and the remainder is what gets compiled. Anything
 * that still will not compile is treated as an error in the authored CSS —
 * `matchSelectors` reports it as a `selector-parse` failure, which the LSP
 * underlines on the selector — rather than guessed at here.
 *
 * `matchSelectors` uses this for every selector it runs. It is exported from
 * this module — not from the package's index — so in-repo dev tooling can ask
 * the *real* matcher about a single instance instead of reimplementing the
 * traversal.
 */
export function compileSelector(
	forest: InstanceForest,
	selector: string,
): CompiledSelector | null {
	const relaxed = relaxSelector(selector);
	try {
		const test = cssCompile<InstanceNode, InstanceNode>(relaxed.relaxed, {
			adapter: makeAdapter(forest.ctx),
		});
		return { test, strippedPseudos: relaxed.stripped };
	} catch {
		return null;
	}
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
	compiled: CompiledSelector;
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

/** What a run of the matcher produced: the matches, and the selectors it could not read. */
export interface SelectorMatchResult {
	/** One entry per source element, keyed by the file it was written in. */
	elementMatches: Map<string, ElementMatches[]>;
	/**
	 * Selectors that would not compile, one per occurrence so each gets its own
	 * squiggle. Never fatal: every other selector still matched.
	 */
	failures: AnalysisFailure[];
}

/**
 * The failure for a selector the matcher cannot read, located on the selector.
 *
 * A selector with no location of its own collapses onto the rule's start as an
 * empty region, which consumers widen for display.
 */
function selectorFailure(rule: CssRule, selector: string, loc: SelectorLoc | undefined): AnalysisFailure {
	const at = loc ?? {
		startLine: rule.sourceLine, startCol: rule.sourceCol,
		endLine: rule.sourceLine, endCol: rule.sourceCol,
	};
	return {
		reason: 'selector-parse',
		sourceFile: rule.sourceFile,
		message: `Backflip cannot parse the selector \`${selector}\``,
		sourceLine: at.startLine,
		sourceCol: at.startCol,
		lostStartLine: at.startLine,
		lostStartCol: at.startCol,
		lostEndLine: at.endLine,
		lostEndCol: at.endCol,
	};
}

/**
 * Match every rule against the render forest, reporting one entry per source
 * element. Counting hits against the element's instance total is what makes
 * `definite` mean "in every context", rather than "in the first context tried".
 *
 * A selector that will not compile is reported in `failures` rather than
 * skipped quietly — see `compileSelector`.
 */
export function matchSelectors(
	rules: CssRule[],
	forest: InstanceForest,
): SelectorMatchResult {
	const result = new Map<string, ElementMatches[]>();
	const failures: AnalysisFailure[] = [];

	// Selectors are compiled once per run. css-select's per-selector "this
	// ancestor did not match" cache is sound here because instances are
	// immutable for the life of the run — but only because the compiled
	// selectors die with it too, so nothing outlives the forest it cached.
	const compiled = new Map<string, CompiledSelector | null>();
	const occurrences: Occurrence[] = [];
	const seen = new Set<string>();
	for (const rule of rules) {
		rule.selectors.forEach((selector, i) => {
			const key = `${selector}:${rule.sourceLine}:${rule.sourceCol}`;
			if (seen.has(key)) return;
			seen.add(key);
			let entry = compiled.get(selector);
			if (entry === undefined) {
				entry = compileSelector(forest, selector);
				compiled.set(selector, entry);
			}
			// Reported per occurrence, not per compile: the same bad selector in
			// two rules is two places an author has to fix, and the compile above
			// only runs for the first of them.
			if (entry) occurrences.push({ rule, selector, compiled: entry });
			else failures.push(selectorFailure(rule, selector, rule.selectorLocs[i]));
		});
	}
	if (occurrences.length === 0) return { elementMatches: result, failures };

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
			if (!occurrence.compiled.test(instance)) continue;
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
				strippedPseudos: occurrence.compiled.strippedPseudos,
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

	return { elementMatches: result, failures };
}
