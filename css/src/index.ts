export type {
	CssRule,
	CssProperty,
	SelectorLoc,
	MatchedRule,
	ElementMatches,
	CssAnalysisInput,
	CssAnalysisResult,
	CssSourceFile,
	CssUrlReference,
	AnalysisFailure,
	AnalysisFailureReason,
} from './types.js';

export { discoverCssFiles, type CssFileRef } from './discover.js';
export {
	relaxSelector,
	type RelaxedSelector,
	type StrippedPseudo,
} from './relax-selector.js';
export {
	PSEUDO_CATEGORIES,
	categoryOf,
	type PseudoCategory,
} from './pseudo-categories.js';
export { extractAssetUrlsFromCss } from './urls.js';

import type { AnalysisFailure, CssAnalysisInput, CssAnalysisResult, CssRule } from './types.js';
import { parseCssFile } from './parse-css.js';
import { buildInstanceForest, MAX_INSTANCES } from './instance-tree.js';
import { matchSelectors } from './selector-match.js';

export { parseCssFile, type CssParseResult } from './parse-css.js';
export {
	attrIndexOf, buildAttrIndex, tagNameOf, isElementLike,
	type ElementLikeTNode, type AttrIndex,
} from './tnode-view.js';
export {
	buildInstanceForest, childrenOf, siblingsOf, attrsOf,
	FOR_REPS, MAX_DEPTH, MAX_INSTANCES,
	type InstanceNode, type InstanceForest, type Env, type SlotEntry,
} from './instance-tree.js';

/**
 * Match a stylesheet against a compiled template directory.
 *
 * Four steps: parse each stylesheet, expand the compiled trees into the render
 * forest, match every selector against every instance, and report one entry per
 * source element. See `css/README.md` for what the model does and does not
 * capture.
 *
 * Stylesheets are parsed one at a time so every rule carries the file it came
 * from. `failures` reports CSS that could not be analyzed — a region css-tree
 * could not parse, or a single selector the matcher cannot read. Neither is
 * fatal: a stylesheet that fails outright still leaves the others analyzed.
 */
export function analyzeCss(input: CssAnalysisInput): CssAnalysisResult {
	const { files, compiled } = input;
	const timings: string[] = [];
	let t = performance.now();

	const rules: CssRule[] = [];
	const failures: AnalysisFailure[] = [];
	for (const file of files) {
		const parsed = parseCssFile(file.content, file.path);
		rules.push(...parsed.rules);
		failures.push(...parsed.failures);
	}
	timings.push(`parse-css: ${(performance.now() - t).toFixed(0)}ms (${files.length} file(s))`);
	if (rules.length === 0) {
		return { elementMatches: new Map(), rules, failures };
	}

	t = performance.now();
	const forest = buildInstanceForest(compiled);
	timings.push(`instance-tree: ${(performance.now() - t).toFixed(0)}ms (${forest.all.length} instances)`);
	if (forest.truncated) {
		console.warn(`[backflip] css analysis stopped expanding at ${MAX_INSTANCES} instances; some matches may be missing`);
	}

	t = performance.now();
	const matched = matchSelectors(rules, forest);
	failures.push(...matched.failures);
	timings.push(`match-selectors: ${(performance.now() - t).toFixed(0)}ms`);

	console.log(`[backflip] css analysis breakdown: ${timings.join(', ')}`);

	return { elementMatches: matched.elementMatches, rules, failures };
}
