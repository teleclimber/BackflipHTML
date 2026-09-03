import type { CompiledFile } from '@backflip/html';
import type { ElementLikeTNode } from './tnode-view.js';

// --- CSS Rule types ---

export interface CssProperty {
	name: string;
	value: string;
}

export interface CssRule {
	/** Full selector text, e.g. ".card > .title, .card > .subtitle" */
	selectorText: string;
	/** Individual selectors split on comma */
	selectors: string[];
	/** Declarations in this rule */
	properties: CssProperty[];
	/** Stack of enclosing @media conditions, e.g. ["(min-width: 768px)"] */
	mediaConditions: string[];
	/** 1-based line number in the CSS file */
	sourceLine: number;
	/** 1-based column in the CSS file */
	sourceCol: number;
}

// --- Match Result types ---

export interface MatchedRule {
	rule: CssRule;
	/** The specific selector that matched (from the comma-separated list) */
	selector: string;
	/** [a, b, c] specificity tuple */
	specificity: [number, number, number];
	/** Media conditions from the rule */
	mediaConditions: string[];
	/**
	 * - 'definite': matches every time this element renders
	 * - 'conditional': matches in some renderings only — a `b-if` branch that may
	 *   not be taken, one position of a `b-for`, or one use of the partial it is in
	 * - 'dynamic': matches only if a `b-bind:class` / `b-bind:id` expression
	 *   evaluates to a matching value
	 */
	matchType: 'definite' | 'conditional' | 'dynamic';
}

export interface ElementMatches {
	/** The compiled TNode that renders this element. */
	element: ElementLikeTNode;
	file: string;
	partialName: string;
	/** Source location for mapping back to editor positions */
	startLine: number;
	startCol: number;
	startOffset: number;
	matches: MatchedRule[];
}

// --- Analysis Result ---

export interface CssUrlReference {
	url: string;
	line: number;
	column: number;
}

export interface CssAnalysisInput {
	cssContent: string;
	/**
	 * Compiled trees for the templates to match against, keyed by relative path,
	 * straight from `compileDirectory` / `compileFiles`. Note these must NOT have
	 * been through `flattenStatics`: it collapses static elements into raw HTML
	 * strings, which a selector cannot match.
	 */
	compiled: Map<string, CompiledFile>;
}

export interface CssAnalysisResult {
	/** Per-file element CSS match results. Key is filePath. */
	elementMatches: Map<string, ElementMatches[]>;
	/** All parsed CSS rules */
	rules: CssRule[];
}
