import * as csstree from '@eslint/css-tree';
import type { AnalysisFailure, CssRule, CssProperty } from './types.js';

/** Byte offsets and 1-based line/column bounds of one discarded region. */
interface LostRegion {
	start: number;
	end: number;
	startLine: number;
	startCol: number;
	endLine: number;
	endCol: number;
}

export interface CssParseResult {
	rules: CssRule[];
	/** Regions css-tree could not parse. See `AnalysisFailure`. */
	failures: AnalysisFailure[];
}

/**
 * The text a nested rule's `&` stands for.
 *
 * Per CSS Nesting, `&` means `:is(<parent selector list>)` — which also gives it
 * the specificity of the most specific parent selector, where expanding into one
 * rule per parent would not. A single parent needs no wrapper: `:is(.card)` and
 * `.card` match and score identically, and the bare form is what an author wrote
 * and what the LSP shows on hover.
 */
function nestingText(parentSelectors: string[]): string {
	return parentSelectors.length === 1 ? parentSelectors[0] : `:is(${parentSelectors.join(',')})`;
}

/** A source range to substitute when rendering a node's authored text. */
interface Replacement {
	start: number;
	end: number;
	text: string;
}

/**
 * Source text of [start, end), with `replacements` substituted into it.
 *
 * A replacement outside the range, or overlapping one already applied, is
 * skipped — a comment inside a range that an `&` substitution replaces
 * wholesale is already gone.
 */
function renderRange(source: string, start: number, end: number, replacements: Replacement[]): string {
	let out = '';
	let at = start;
	for (const r of [...replacements].sort((a, b) => a.start - b.start)) {
		if (r.start < at || r.end > end) continue;
		out += source.slice(at, r.start) + r.text;
		at = r.end;
	}
	return out + source.slice(at, end);
}

/**
 * One selector's text, sliced from the source and patched — or null if a node
 * carries no location.
 *
 * Slicing rather than regenerating is deliberate. `csstree.generate` normalizes
 * whitespace it is not free to normalize: `:nth-child(2 of .x)` comes back as
 * `:nth-child(2 of.x)`, which is legal CSS — `.` cannot continue an identifier —
 * but css-select matches the `of` clause with a regex demanding whitespace on
 * both sides, so the selector threw and was dropped from the analysis entirely.
 * The authored text is also what the LSP shows on hover, so a normalized form
 * misreports the rule even when it matches.
 *
 * Two things are patched in, both located by node rather than by searching the
 * text. Comments, which the parser drops and the slice keeps: a comment is not
 * a separator, so it is replaced with nothing, making `.a`+comment+`.b` the
 * compound `.a.b` — how the parser itself reads it. And `&`, which stands for
 * the parent: it is a `NestingSelector` node, so an ampersand that is merely
 * text — `[data-q="a&b"]` — is left alone, which a string replace would
 * corrupt. A nested selector with no `&` of its own is a descendant of the
 * parent, which is what the spec says a bare nested selector means.
 */
function authoredSelector(
	source: string,
	selector: csstree.CssNode,
	comments: Replacement[],
	parentText: string | null,
): string | null {
	if (!selector.loc) return null;
	const { start, end } = selector.loc;
	const replacements = comments.filter(c => c.start >= start.offset && c.end <= end.offset);

	let sawNesting = false;
	let located = true;
	if (parentText !== null) {
		csstree.walk(selector, {
			visit: 'NestingSelector',
			enter(node: csstree.CssNode) {
				sawNesting = true;
				if (node.loc) {
					replacements.push({ start: node.loc.start.offset, end: node.loc.end.offset, text: parentText });
				} else {
					located = false;
				}
			},
		});
		if (!located) return null;
	}

	const text = renderRange(source, start.offset, end.offset, replacements).trim();
	if (parentText === null || sawNesting) return text;
	return `${parentText} ${text}`;
}

/**
 * The same text via `csstree.generate`, for a node the parser located nowhere.
 *
 * Unreachable while `positions: true` holds, but `loc` is optional on every
 * node, and a normalized selector beats no selector at all.
 */
function generatedSelector(selector: csstree.CssNode, parentText: string | null): string {
	if (parentText === null) return csstree.generate(selector);

	const copy = csstree.clone(selector);
	let sawNesting = false;
	csstree.walk(copy, {
		visit: 'NestingSelector',
		enter(_node: csstree.CssNode, item, list) {
			sawNesting = true;
			list.replace(item, csstree.List.createItem<csstree.CssNode>({ type: 'Raw', value: parentText }));
		},
	});

	const text = csstree.generate(copy);
	return sawNesting ? text : `${parentText} ${text}`;
}

/**
 * Parse one stylesheet into rules, reporting what could not be parsed.
 *
 * css-tree never throws on malformed CSS — it skips to a recovery point and
 * carries on with fewer rules. `onParseError` is the only way to learn that
 * happened, and its second argument is the node css-tree fell back to, whose
 * location is the extent of the discarded text. That node is typed as always
 * present but is null when the parser had nothing to fall back to (a malformed
 * at-rule prelude, say), so the error's own position stands in for it.
 */
export function parseCssFile(cssContent: string, sourceFile = ''): CssParseResult {
	const rules: CssRule[] = [];
	const failures: AnalysisFailure[] = [];

	// One malformed construct can raise several errors covering the same text:
	// a missing brace reports both the unexpected token and the brace it never
	// found, and css-tree widens the region it discards as it recovers. Those
	// are one failure, not several, so overlapping regions merge into the first
	// reported — which keeps the message naming the actual cause, while the
	// region grows to the full extent of what was dropped.
	//
	// Bounds are inclusive: an error the parser reports with no fallback node
	// contributes an empty region, and an empty region overlaps nothing under
	// strict comparison, so it would survive as a second warning underlining
	// text the merged one already covers.
	const spans: { region: LostRegion; failure: AnalysisFailure }[] = [];

	// The parser drops comments; a source slice keeps them. Their bounds have to
	// come from the parse, not from a search of the text — `onComment` never
	// fires for a `/*` inside a string, where a regex would happily match.
	const comments: Replacement[] = [];

	/** Grow `span` to also cover `region`, keeping its failure's bounds in step. */
	const absorb = (span: (typeof spans)[number], region: LostRegion) => {
		if (region.start < span.region.start) {
			span.region.start = region.start;
			span.region.startLine = span.failure.lostStartLine = region.startLine;
			span.region.startCol = span.failure.lostStartCol = region.startCol;
		}
		if (region.end > span.region.end) {
			span.region.end = region.end;
			span.region.endLine = span.failure.lostEndLine = region.endLine;
			span.region.endCol = span.failure.lostEndCol = region.endCol;
		}
	};

	const ast = csstree.parse(cssContent, {
		positions: true,
		onComment(_value: string, loc: csstree.CssLocationRange) {
			comments.push({ start: loc.start.offset, end: loc.end.offset, text: '' });
		},
		onParseError(error: csstree.SyntaxParseError, fallbackNode: csstree.CssNode | null) {
			// No fallback node, or one parsed without positions: nothing was
			// identified as discarded, so the failure collapses onto the error
			// itself. Consumers widen an empty region for display.
			const lost = fallbackNode?.loc ?? {
				start: { offset: error.offset, line: error.line, column: error.column },
				end: { offset: error.offset, line: error.line, column: error.column },
			};

			const region: LostRegion = {
				start: lost.start.offset,
				end: lost.end.offset,
				startLine: lost.start.line,
				startCol: lost.start.column,
				endLine: lost.end.line,
				endCol: lost.end.column,
			};

			// A region can bridge two spans that were disjoint until now — the
			// widening error arrives after the pinpoint ones it spans. Keep the
			// earliest, since its message named the cause, and fold the rest in.
			const touching = spans.filter(s => region.start <= s.region.end && region.end >= s.region.start);
			if (touching.length > 0) {
				const [keep, ...merged] = touching;
				absorb(keep, region);
				for (const other of merged) {
					absorb(keep, other.region);
					spans.splice(spans.indexOf(other), 1);
					failures.splice(failures.indexOf(other.failure), 1);
				}
				return;
			}

			const failure: AnalysisFailure = {
				reason: 'stylesheet-parse',
				sourceFile,
				message: error.message,
				sourceLine: error.line,
				sourceCol: error.column,
				lostStartLine: region.startLine,
				lostStartCol: region.startCol,
				lostEndLine: region.endLine,
				lostEndCol: region.endCol,
			};
			spans.push({ region, failure });
			failures.push(failure);
		},
	});

	const mediaStack: string[] = [];
	// Resolved selector lists of the enclosing rules, innermost last. A nested
	// rule is a `Rule` inside its parent's `Block`, so this is pushed and popped
	// exactly like `mediaStack` — the walk already had the shape nesting needs.
	// Entries are already absolute, so resolving is only ever one level deep.
	const selectorStack: string[][] = [];
	const skipAtrules = new Set(['keyframes', 'font-face', 'import', 'charset', 'namespace']);

	csstree.walk(ast, {
		enter(node: csstree.CssNode) {
			if (node.type === 'Atrule') {
				if (node.name === 'media' && node.prelude) {
					mediaStack.push(csstree.generate(node.prelude));
				} else if (skipAtrules.has(node.name)) {
					return csstree.walk.skip;
				}
				return;
			}

			if (node.type === 'Rule') {
				const parent = selectorStack[selectorStack.length - 1];
				const parentText = parent ? nestingText(parent) : null;

				// Extract individual selectors from the SelectorList, resolving
				// each against the enclosing rule. At the top level there is no
				// parent, and a stray `&` there simply fails to compile later.
				const selectors: string[] = [];
				if (node.prelude.type === 'SelectorList') {
					node.prelude.children.forEach((selector: csstree.CssNode) => {
						selectors.push(authoredSelector(cssContent, selector, comments, parentText)
							?? generatedSelector(selector, parentText));
					});
				} else {
					// A prelude css-tree declined to parse as a selector list. Its raw
					// text is pushed as authored — css-select will refuse it, and
					// `onParseError` has already reported the region — which also means
					// there is no NestingSelector node here to resolve an `&` through.
					selectors.push(authoredSelector(cssContent, node.prelude, comments, null)
						?? csstree.generate(node.prelude));
				}

				// Every rule pushes, nested or not, so `leave` can pop blindly.
				selectorStack.push(selectors);

				// Extract declarations. Nested rules are `Rule` children of the
				// same block and are picked up by the walk, not from here.
				const properties: CssProperty[] = [];
				if (node.block) {
					node.block.children.forEach((child: csstree.CssNode) => {
						if (child.type === 'Declaration') {
							properties.push({
								name: child.property,
								value: csstree.generate(child.value),
							});
						}
					});
				}

				const loc = node.loc;
				rules.push({
					selectorText: selectors.join(','),
					selectors,
					properties,
					mediaConditions: [...mediaStack],
					sourceFile,
					sourceLine: loc?.start.line ?? 0,
					sourceCol: loc?.start.column ?? 0,
				});
			}
		},
		leave(node: csstree.CssNode) {
			if (node.type === 'Atrule' && node.name === 'media') {
				mediaStack.pop();
			} else if (node.type === 'Rule') {
				selectorStack.pop();
			}
		},
	});

	return { rules, failures };
}
