import type { DefaultTreeAdapterMap } from 'parse5';

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

// --- DOM / Template types ---

export interface BDirectiveInfo {
	bName?: string;
	bExport?: boolean;
	bPart?: string;
	bPartParsed?: { partialName: string; targetFile: string | null };
	bFor?: string;
	bIf?: string;
	bElseIf?: string;
	bElse?: boolean;
	bSlot?: string;
	bIn?: string;
	bUnwrap?: boolean;
	/** Attribute names that are dynamically bound (b-bind:X or :X) */
	dynamicAttrs: string[];
}

export type Element = DefaultTreeAdapterMap['element'];
export type ChildNode = DefaultTreeAdapterMap['childNode'];
export type TextNode = DefaultTreeAdapterMap['textNode'];
export type Document = DefaultTreeAdapterMap['document'];
export type DocumentFragment = DefaultTreeAdapterMap['documentFragment'];

/** Map from Element to its directive info. */
export type DirectiveMap = WeakMap<Element, BDirectiveInfo>;

export interface ParsedTemplate {
	filePath: string;
	fragment: DocumentFragment;
	/** All elements in the file that have at least one b-directive or are regular elements. */
	elements: Element[];
	/** Directive metadata for elements. */
	directives: DirectiveMap;
}

// --- Usage Graph types ---

export interface PartialDefinition {
	name: string;
	file: string;
	/** The element with b-name */
	rootElement: Element;
	/** slotName -> element with b-slot */
	slotElements: Map<string, Element>;
}

export interface PartialUsageSite {
	file: string;
	/** The element with b-part */
	element: Element;
	partialName: string;
	targetFile: string | null;
	/** DOM parent of the b-part element (null if at root) */
	parentElement: Element | null;
	/** slotName -> elements with b-in */
	slotInjections: Map<string, Element[]>;
	/** The b-name partial this usage site is lexically inside, or null if at file root */
	containingPartialName: string | null;
}

export interface UsageGraph {
	definitions: Map<string, PartialDefinition[]>;
	usages: Map<string, PartialUsageSite[]>;
	/** filePath -> all elements in file */
	fileElements: Map<string, Element[]>;
	/** Directive metadata across all templates */
	directives: DirectiveMap;
}

// --- Context Spine types ---

export interface SpineNode {
	tagName: string;
	attrs: { name: string; value: string }[];
	/** Attribute names that are dynamically bound */
	dynamicAttrs: string[];
	isConditional: boolean;
	children: SpineNode[];
	parent: SpineNode | null;
	sourceFile: string;
	/** Back-reference to original element for location info */
	sourceElement: Element | null;
}

export interface ContextSpine {
	/** Ancestors from outermost to innermost (just before the target element) */
	ancestors: SpineNode[];
	/** True if any ancestor in the spine is conditional (b-if/b-else-if/b-else) */
	isConditional: boolean;
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
	 * - 'definite': matches in all contexts
	 * - 'conditional': matches only in some b-if branches
	 * - 'dynamic': matches only if b-bind:class/id resolves to certain values
	 */
	matchType: 'definite' | 'conditional' | 'dynamic';
}

export interface ElementMatches {
	element: Element;
	file: string;
	partialName: string;
	/** Source location for mapping back to editor positions */
	startLine: number;
	startCol: number;
	startOffset: number;
	matches: MatchedRule[];
}

// --- Partial Source Info ---

export interface PartialSourceInfo {
	startOffset: number;   // 0-based, start of opening tag '<'
	endOffset: number;     // 0-based, just past closing tag '>'
	startLine: number;     // 1-based
	startCol: number;      // 1-based
	isDocumentLevel: boolean;  // true if partial contains/is html, head, or body
}

// --- Analysis Result ---

export interface CssAnalysisInput {
	cssContent: string;
	templateFiles: Map<string, string>;
	/** Per-file partial metadata from the compiler. filePath -> partialName -> info */
	partialInfo: Map<string, Map<string, PartialSourceInfo>>;
}

export interface CssAnalysisResult {
	/** Per-file element CSS match results. Key is filePath. */
	elementMatches: Map<string, ElementMatches[]>;
	/** All parsed CSS rules */
	rules: CssRule[];
}
