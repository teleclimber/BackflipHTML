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
				const selectorText = csstree.generate(node.prelude);

				// Extract individual selectors from the SelectorList
				const selectors: string[] = [];
				if (node.prelude.type === 'SelectorList') {
					node.prelude.children.forEach((selector: csstree.CssNode) => {
						selectors.push(csstree.generate(selector));
					});
				} else {
					selectors.push(selectorText);
				}

				// Extract declarations
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
					selectorText,
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
			}
		},
	});

	return { rules, failures };
}
