export type {
	CssRule,
	CssProperty,
	MatchedRule,
	ElementMatches,
	CssAnalysisInput,
	CssAnalysisResult,
	CssUrlReference,
} from './types.js';

export { discoverCssFiles, type CssFileRef } from './discover.js';
export { extractAssetUrlsFromCss } from './urls.js';

import type { CssAnalysisInput, CssAnalysisResult } from './types.js';
import { parseCssFile } from './parse-css.js';
import { buildInstanceForest, MAX_INSTANCES } from './instance-tree.js';
import { matchSelectors } from './selector-match.js';

export { parseCssFile } from './parse-css.js';
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
 * Four steps: parse the CSS, expand the compiled trees into the render forest,
 * match every selector against every instance, and report one entry per source
 * element. See `css/README.md` for what the model does and does not capture.
 */
export function analyzeCss(input: CssAnalysisInput): CssAnalysisResult {
	const { cssContent, compiled } = input;
	const timings: string[] = [];
	let t = performance.now();

	const rules = parseCssFile(cssContent);
	timings.push(`parse-css: ${(performance.now() - t).toFixed(0)}ms`);
	if (rules.length === 0) {
		return { elementMatches: new Map(), rules };
	}

	t = performance.now();
	const forest = buildInstanceForest(compiled);
	timings.push(`instance-tree: ${(performance.now() - t).toFixed(0)}ms (${forest.all.length} instances)`);
	if (forest.truncated) {
		console.warn(`[backflip] css analysis stopped expanding at ${MAX_INSTANCES} instances; some matches may be missing`);
	}

	t = performance.now();
	const elementMatches = matchSelectors(rules, forest);
	timings.push(`match-selectors: ${(performance.now() - t).toFixed(0)}ms`);

	console.log(`[backflip] css analysis breakdown: ${timings.join(', ')}`);

	return { elementMatches, rules };
}
