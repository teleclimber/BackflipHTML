export type {
	CssRule,
	CssProperty,
	MatchedRule,
	ElementMatches,
	CssAnalysisInput,
	CssAnalysisResult,
	ContextSpine,
	SpineNode,
	BDirectiveInfo,
	PartialSourceInfo,
	CssUrlReference,
} from './types.js';

export { discoverCssFiles, type CssFileRef } from './discover.js';
export { extractAssetUrlsFromCss } from './urls.js';

import type { CssAnalysisInput, CssAnalysisResult, ContextSpine, PartialUsageSite } from './types.js';
import type { CompiledFile, PartialRefTNode } from '@backflip/html';
import { parseCssFile } from './parse-css.js';
import { parseTemplate } from './parse-dom.js';
import { buildUsageGraph } from './usage-graph.js';
import { computeSpines, computeSlotSpineAncestors } from './context-spines.js';
import { matchSelectors, type MatchRoots } from './selector-match.js';
import { collectBPartRefs, findBPartRefInRange } from './tnode-view.js';

export { parseCssFile } from './parse-css.js';
export { parseTemplate } from './parse-dom.js';
export { buildUsageGraph } from './usage-graph.js';
export { computeSpines } from './context-spines.js';
export {
	attrIndexOf, tagNameOf, isElementLike, buildElementView,
	type ElementLikeTNode, type AttrIndex, type ElementView,
} from './tnode-view.js';

/**
 * The `b-part` call in the compiled tree that a DOM-side usage site refers to.
 * The usage graph is built from parse5, the trees being matched come from the
 * compiler; the two meet at source offsets, which are file-relative on both sides.
 */
function findRefForSite(
	site: PartialUsageSite,
	refsByFile: Map<string, ReturnType<typeof collectBPartRefs>>,
	compiled: Map<string, CompiledFile>,
): PartialRefTNode | null {
	const openTag = site.element.sourceCodeLocation?.startTag ?? site.element.sourceCodeLocation;
	if (!openTag) return null;
	let refs = refsByFile.get(site.file);
	if (!refs) {
		const file = compiled.get(site.file);
		if (!file) return null;
		refs = collectBPartRefs(file);
		refsByFile.set(site.file, refs);
	}
	return findBPartRefInRange(refs, openTag.startOffset, openTag.endOffset, site.partialName);
}

export function analyzeCss(input: CssAnalysisInput): CssAnalysisResult {
	const { cssContent, templateFiles, partialInfo, compiled } = input;
	const timings: string[] = [];
	let t = performance.now();

	// Step 1: Parse CSS
	const rules = parseCssFile(cssContent);
	timings.push(`parse-css: ${(performance.now() - t).toFixed(0)}ms`);
	if (rules.length === 0) {
		return { elementMatches: new Map(), rules };
	}

	// Step 2: Parse all templates
	t = performance.now();
	const templates = [];
	for (const [filePath, html] of templateFiles) {
		const filePartials = partialInfo.get(filePath);
		if (!filePartials || filePartials.size === 0) continue;
		templates.push(parseTemplate(html, filePath, filePartials));
	}
	timings.push(`parse-templates: ${(performance.now() - t).toFixed(0)}ms`);

	// Step 3: Build usage graph
	t = performance.now();
	const usageGraph = buildUsageGraph(templates);
	timings.push(`usage-graph: ${(performance.now() - t).toFixed(0)}ms`);

	// Step 4: Compute context spines for each partial
	t = performance.now();
	const spinesCache = new Map<string, ContextSpine[]>();
	for (const partialName of usageGraph.definitions.keys()) {
		spinesCache.set(partialName, computeSpines(partialName, usageGraph));
	}
	timings.push(`spines: ${(performance.now() - t).toFixed(0)}ms`);

	// Step 5: One match root per compiled partial. The compiler is the authority
	// on which partials a file defines — the DOM-side graph is not, since parse5
	// merges two document-level partials in one file into a single document.
	const partialRoots = new Map<string, MatchRoots>();
	for (const [filePath, file] of compiled) {
		for (const [partialName, root] of file.partials) {
			const key = `${filePath}#${partialName}`;
			partialRoots.set(key, {
				roots: root.tnodes,
				file: filePath,
				partialName,
			});
			// Use the same spines cache key
			if (!spinesCache.has(key)) {
				spinesCache.set(key, spinesCache.get(partialName) ?? [{ ancestors: [], isConditional: false }]);
			}
		}
	}

	// Step 5b: Collect slot content (b-in elements) as its own match root.
	// Slot content at runtime lives inside the partial's DOM where b-slot is,
	// so its ancestor chain is: partial's context spine + internal ancestors to b-slot
	const refsByFile = new Map<string, ReturnType<typeof collectBPartRefs>>();
	for (const [partialName, sites] of usageGraph.usages) {
		for (const site of sites) {
			if (site.slotInjections.size === 0) continue;

			// Resolve which partial definition this usage targets
			const targetPartialName = site.partialName;
			const resolvedFile = site.targetFile ?? site.file;
			const defs = usageGraph.definitions.get(targetPartialName);
			if (!defs) continue;
			const def = defs.find(d => d.file === resolvedFile);
			if (!def) continue;

			const ref = findRefForSite(site, refsByFile, compiled);
			if (!ref) continue;

			for (const [slotName] of site.slotInjections) {
				// Compute internal ancestors from b-slot up to b-name root
				const internalAncestors = computeSlotSpineAncestors(
					targetPartialName, slotName, usageGraph,
				);
				if (internalAncestors.length === 0) continue;

				const slotTnodes = ref.slots[slotName];
				if (!slotTnodes || slotTnodes.length === 0) continue;

				// Get the partial's context spines and prepend internal ancestors
				const partialSpines = spinesCache.get(targetPartialName)
					?? [{ ancestors: [], isConditional: false }];
				const slotSpines = partialSpines.map(ps => ({
					ancestors: [...ps.ancestors, ...internalAncestors],
					isConditional: ps.isConditional,
				}));

				const key = `slot:${site.file}:${ref.loc?.startOffset ?? 0}:${slotName}`;
				partialRoots.set(key, {
					roots: slotTnodes,
					file: site.file,
					partialName: site.containingPartialName ?? partialName,
				});
				spinesCache.set(key, slotSpines);
			}
		}
	}

	// Step 6: Match selectors
	t = performance.now();
	const elementMatches = matchSelectors(rules, partialRoots, spinesCache);
	timings.push(`match-selectors: ${(performance.now() - t).toFixed(0)}ms`);

	console.log(`[backflip] css analysis breakdown: ${timings.join(', ')}`);

	return { elementMatches, rules };
}
