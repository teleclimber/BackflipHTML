import type {
	UsageGraph,
	ContextSpine,
	SpineNode,
	Element,
	BDirectiveInfo,
} from './types.js';

function isElement(node: unknown): node is Element {
	return node != null && typeof node === 'object' && 'tagName' in node;
}

function makeSpineNode(
	el: Element,
	dirInfo: BDirectiveInfo | undefined,
	sourceFile: string,
): SpineNode {
	const isConditional = !!(dirInfo?.bIf || dirInfo?.bElseIf || dirInfo?.bElse);
	return {
		tagName: el.tagName,
		attrs: el.attrs.map(a => ({ name: a.name, value: a.value })),
		dynamicAttrs: dirInfo?.dynamicAttrs ? [...dirInfo.dynamicAttrs] : [],
		isConditional,
		children: [],
		parent: null,
		sourceFile,
		sourceElement: el,
	};
}

/**
 * Walk from an element up to the root of its file, collecting ancestor SpineNodes.
 * Returns ancestors from outermost to innermost.
 *
 * When a b-part ancestor is encountered, its static DOM is replaced by the
 * target partial's internal DOM (from b-name down to the b-slot where the
 * element's b-in content would be injected). This correctly models the
 * runtime ancestor chain for slot content.
 */
function collectAncestors(
	startElement: Element,
	sourceFile: string,
	usageGraph: UsageGraph,
): { ancestors: SpineNode[]; outerPartialName: string | null } {
	const ancestors: SpineNode[] = [];
	let outerPartialName: string | null = null;
	let current: unknown = (startElement as any).parentNode;

	while (current && isElement(current)) {
		const dirInfo = usageGraph.directives.get(current);

		// Check if this ancestor defines a partial (b-name)
		if (dirInfo?.bName) {
			outerPartialName = dirInfo.bName;
			break;
		}

		// Skip b-unwrap elements
		if (current.tagName === 'b-unwrap') {
			current = (current as any).parentNode;
			continue;
		}

		// If this ancestor has b-part, the runtime ancestor chain goes through
		// the target partial's internal DOM, not through this static b-part element.
		// Determine which slot we're injecting into and splice in the partial's
		// internal ancestors (from b-name down to b-slot).
		if (dirInfo?.bPartParsed) {
			const slotName = findSlotNameForChild(startElement, current as Element, usageGraph);
			const internalAncestors = computeSlotSpineAncestors(
				dirInfo.bPartParsed.partialName,
				slotName,
				usageGraph,
			);
			// Insert internal ancestors (they go between the b-part's own
			// ancestors and the slot content's ancestors)
			ancestors.push(...internalAncestors);
			// Continue walking up from the b-part element (skip the b-part itself)
			current = (current as any).parentNode;
			continue;
		}

		ancestors.push(makeSpineNode(current, dirInfo, sourceFile));
		current = (current as any).parentNode;
	}

	// Reverse so outermost is first
	ancestors.reverse();
	return { ancestors, outerPartialName };
}

/**
 * Determine which slot a child element targets within a b-part element.
 * Walks from the child up to the b-part element looking for b-in directives.
 * Returns the slot name, defaulting to 'default'.
 */
function findSlotNameForChild(
	child: Element,
	bPartElement: Element,
	usageGraph: UsageGraph,
): string {
	let current: unknown = child;
	while (current && isElement(current)) {
		if (current === bPartElement) break;
		const dirInfo = usageGraph.directives.get(current);
		if (dirInfo?.bIn !== undefined) {
			return dirInfo.bIn;
		}
		current = (current as any).parentNode;
	}
	// Also check direct children of b-part that are ancestors of child
	// but walk through the child's immediate ancestors
	return 'default';
}

/**
 * Compute the internal ancestor chain from a b-slot element up to (and including)
 * the b-name root element. Returns SpineNodes from outermost (b-name) to innermost
 * (direct parent of b-slot). Skips b-unwrap elements.
 *
 * When the b-slot sits inside a b-part call body the partial is *forwarding* its
 * slot (`<div b-part="#child"><b-unwrap b-in="inner" b-slot="outer"/></div>`): at
 * runtime the content lands inside the callee's own DOM, so that callee's internal
 * chain down to the forwarded-into slot is spliced in below the b-part element.
 *
 * `seen` guards against a b-part cycle, which the compiler rejects but raw HTML
 * analysis can still encounter.
 */
export function computeSlotSpineAncestors(
	partialName: string,
	slotName: string,
	usageGraph: UsageGraph,
	seen: Set<string> = new Set(),
): SpineNode[] {
	const defs = usageGraph.definitions.get(partialName);
	if (!defs || defs.length === 0) return [];
	if (seen.has(partialName)) return [];
	seen = new Set(seen).add(partialName);

	const def = defs[0];
	const slotElement = def.slotElements.get(slotName);
	if (!slotElement) return [];

	// Walk from b-slot up to (and including) the b-name root, innermost first.
	const ancestors: SpineNode[] = [];
	let current: unknown = slotElement;

	// If the slot element itself is b-unwrap, skip it and start from its parent
	if ((current as Element).tagName === 'b-unwrap') {
		current = (current as any).parentNode;
	}

	while (current && isElement(current)) {
		const dirInfo = usageGraph.directives.get(current);

		// A b-part ancestor means this b-slot is a forward: splice the callee's
		// chain down to the slot being forwarded into. Those nodes are inner to
		// the b-part element, so they go in first (this list is innermost-first).
		if (dirInfo?.bPartParsed) {
			const forwardedTo = findSlotNameForChild(slotElement, current as Element, usageGraph);
			const calleeAncestors = computeSlotSpineAncestors(
				dirInfo.bPartParsed.partialName, forwardedTo, usageGraph, seen,
			);
			for (let i = calleeAncestors.length - 1; i >= 0; i--) ancestors.push(calleeAncestors[i]);
			// The carrying tag renders unless it is a b-unwrap.
			if (current.tagName !== 'b-unwrap') ancestors.push(makeSpineNode(current, dirInfo, def.file));
			current = (current as any).parentNode;
			continue;
		}

		if (current.tagName === 'b-unwrap') {
			current = (current as any).parentNode;
			continue;
		}

		ancestors.push(makeSpineNode(current, dirInfo, def.file));

		// If we've reached the b-name root, stop
		if (dirInfo?.bName === partialName) break;

		current = (current as any).parentNode;
	}

	ancestors.reverse();
	return ancestors;
}

export function computeSpines(
	partialName: string,
	usageGraph: UsageGraph,
	maxDepth: number = 20,
): ContextSpine[] {
	return computeSpinesRecursive(partialName, usageGraph, maxDepth, 0);
}

function computeSpinesRecursive(
	partialName: string,
	usageGraph: UsageGraph,
	maxDepth: number,
	currentDepth: number,
): ContextSpine[] {
	const sites = usageGraph.usages.get(partialName);

	if (!sites || sites.length === 0) {
		return [{ ancestors: [], isConditional: false }];
	}

	if (currentDepth >= maxDepth) {
		return [{ ancestors: [], isConditional: false }];
	}

	const spines: ContextSpine[] = [];

	for (const site of sites) {
		const { ancestors, outerPartialName } = collectAncestors(
			site.element,
			site.file,
			usageGraph,
		);

		const localConditional = ancestors.some(a => a.isConditional);

		if (outerPartialName) {
			// This usage is inside another partial — recurse
			const outerSpines = computeSpinesRecursive(
				outerPartialName,
				usageGraph,
				maxDepth,
				currentDepth + 1,
			);

			for (const outerSpine of outerSpines) {
				const combined = [...outerSpine.ancestors, ...ancestors];
				spines.push({
					ancestors: combined,
					isConditional: outerSpine.isConditional || localConditional,
				});
			}
		} else {
			spines.push({
				ancestors,
				isConditional: localConditional,
			});
		}
	}

	return spines;
}
