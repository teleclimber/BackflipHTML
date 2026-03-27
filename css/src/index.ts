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
} from './types.js';

import type { CssAnalysisInput, CssAnalysisResult, ContextSpine } from './types.js';
import { parseCssFile } from './parse-css.js';
import { parseTemplate } from './parse-dom.js';
import { buildUsageGraph } from './usage-graph.js';
import { computeSpines, computeSlotSpineAncestors } from './context-spines.js';
import { matchSelectors, matchNodeFromElement, type MatchNode } from './selector-match.js';

export { parseCssFile } from './parse-css.js';
export { parseTemplate } from './parse-dom.js';
export { buildUsageGraph } from './usage-graph.js';
export { computeSpines } from './context-spines.js';

export function analyzeCss(input: CssAnalysisInput): CssAnalysisResult {
	const { cssContent, templateFiles } = input;
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
		templates.push(parseTemplate(html, filePath));
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

	// Step 5: Build MatchNode trees for each partial's elements
	const partialRoots = new Map<string, { roots: MatchNode[]; file: string; partialName: string }>();
	for (const [partialName, defs] of usageGraph.definitions) {
		for (const def of defs) {
			const key = `${def.file}#${partialName}`;
			const root = matchNodeFromElement(def.rootElement, usageGraph.directives, null);
			// The roots are the children of the partial definition element,
			// since the b-name element itself is the partial wrapper
			partialRoots.set(key, {
				roots: [root],
				file: def.file,
				partialName,
			});
			// Use the same spines cache key
			if (!spinesCache.has(key)) {
				spinesCache.set(key, spinesCache.get(partialName) ?? [{ ancestors: [], isConditional: false }]);
			}
		}
	}

	// Step 5b: Build MatchNode trees for slot content (b-in elements)
	// Slot content at runtime lives inside the partial's DOM where b-slot is,
	// so its ancestor chain is: partial's context spine + internal ancestors to b-slot
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

			for (const [slotName, injectionElements] of site.slotInjections) {
				// Compute internal ancestors from b-slot up to b-name root
				const internalAncestors = computeSlotSpineAncestors(
					targetPartialName, slotName, usageGraph,
				);
				if (internalAncestors.length === 0) continue;

				// Get the partial's context spines and prepend internal ancestors
				const partialSpines = spinesCache.get(targetPartialName)
					?? [{ ancestors: [], isConditional: false }];
				const slotSpines = partialSpines.map(ps => ({
					ancestors: [...ps.ancestors, ...internalAncestors],
					isConditional: ps.isConditional,
				}));

				for (const injEl of injectionElements) {
					const key = `slot:${site.file}:${injEl.sourceCodeLocation?.startOffset ?? 0}`;
					const root = matchNodeFromElement(injEl, usageGraph.directives, null);
					partialRoots.set(key, {
						roots: [root],
						file: site.file,
						partialName: targetPartialName,
					});
					spinesCache.set(key, slotSpines);
				}
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
