import { is as cssIs } from 'css-select';
import { calculate } from 'specificity';
import type {
	CssRule, MatchedRule, ElementMatches, Element, SpineNode,
	ContextSpine, UsageGraph, DirectiveMap, BDirectiveInfo,
} from './types.js';

// --- Unified node type for css-select adapter ---

interface MatchNode {
	kind: 'element' | 'spine' | 'text' | 'root';
	tagName: string;
	attrs: { name: string; value: string }[];
	dynamicAttrs: string[];
	isConditional: boolean;
	children: MatchNode[];
	parent: MatchNode | null;
	/** Back-reference to the original parse5 element (for element nodes) */
	sourceElement: Element | null;
}

function matchNodeFromElement(el: Element, directives: DirectiveMap, parent: MatchNode | null): MatchNode {
	const info = directives.get(el);
	const node: MatchNode = {
		kind: 'element',
		tagName: el.tagName,
		attrs: el.attrs.map(a => ({ name: a.name, value: a.value })),
		dynamicAttrs: info?.dynamicAttrs ?? [],
		isConditional: !!(info?.bIf || info?.bElseIf || info?.bElse),
		children: [],
		parent,
		sourceElement: el,
	};
	// Recursively convert children
	if (el.childNodes) {
		for (const child of el.childNodes) {
			if ('tagName' in child) {
				const childNode = matchNodeFromElement(child as Element, directives, node);
				node.children.push(childNode);
			}
		}
	}
	return node;
}

function matchNodeFromSpine(spine: SpineNode): MatchNode {
	const node: MatchNode = {
		kind: 'spine',
		tagName: spine.tagName,
		attrs: [...spine.attrs],
		dynamicAttrs: spine.dynamicAttrs,
		isConditional: spine.isConditional,
		children: [],
		parent: null,
		sourceElement: spine.sourceElement,
	};
	return node;
}

function makeRootNode(): MatchNode {
	return {
		kind: 'root',
		tagName: '',
		attrs: [],
		dynamicAttrs: [],
		isConditional: false,
		children: [],
		parent: null,
		sourceElement: null,
	};
}

// --- css-select adapter ---

function isTag(node: MatchNode): boolean {
	return node.kind === 'element' || node.kind === 'spine';
}

const adapter = {
	isTag(node: MatchNode): node is MatchNode {
		return isTag(node);
	},

	existsOne(test: (node: MatchNode) => boolean, elems: MatchNode[]): boolean {
		for (const el of elems) {
			if (isTag(el) && test(el)) return true;
			if (el.children.length > 0 && adapter.existsOne(test, el.children)) return true;
		}
		return false;
	},

	getAttributeValue(elem: MatchNode, name: string): string | undefined {
		const attr = elem.attrs.find(a => a.name === name);
		return attr?.value;
	},

	getChildren(node: MatchNode): MatchNode[] {
		return node.children;
	},

	getName(elem: MatchNode): string {
		return elem.tagName;
	},

	getParent(node: MatchNode): MatchNode | null {
		return node.parent;
	},

	getSiblings(node: MatchNode): MatchNode[] {
		if (!node.parent) return [node];
		return node.parent.children;
	},

	getText(node: MatchNode): string {
		return '';
	},

	hasAttrib(elem: MatchNode, name: string): boolean {
		return elem.attrs.some(a => a.name === name);
	},

	removeSubsets(nodes: MatchNode[]): MatchNode[] {
		const result: MatchNode[] = [];
		for (const node of nodes) {
			let dominated = false;
			for (const other of nodes) {
				if (node === other) continue;
				let parent = node.parent;
				while (parent) {
					if (parent === other) { dominated = true; break; }
					parent = parent.parent;
				}
				if (dominated) break;
			}
			if (!dominated) result.push(node);
		}
		return result;
	},

	findAll(test: (node: MatchNode) => boolean, nodes: MatchNode[]): MatchNode[] {
		const result: MatchNode[] = [];
		function walk(list: MatchNode[]) {
			for (const node of list) {
				if (isTag(node) && test(node)) result.push(node);
				walk(node.children);
			}
		}
		walk(nodes);
		return result;
	},

	findOne(test: (node: MatchNode) => boolean, elems: MatchNode[]): MatchNode | null {
		for (const el of elems) {
			if (isTag(el) && test(el)) return el;
			const found = adapter.findOne(test, el.children);
			if (found) return found;
		}
		return null;
	},
};

// --- Grafting: attach element subtree onto a spine ---

function graftOntoSpine(elementNode: MatchNode, spine: ContextSpine): MatchNode {
	// Build spine chain from outermost to innermost
	const root = makeRootNode();
	let current: MatchNode = root;

	for (const ancestor of spine.ancestors) {
		const spineNode = matchNodeFromSpine(ancestor);
		spineNode.parent = current;
		current.children = [spineNode];
		current = spineNode;
	}

	// Attach the element as a child of the innermost spine node
	elementNode.parent = current;
	current.children = [elementNode];

	return root;
}

// --- Specificity ---

function getSpecificity(selector: string): [number, number, number] {
	const result = calculate(selector);
	return [result.A, result.B, result.C];
}

// --- Selector uses class/id check ---

function selectorUsesClass(selector: string): boolean {
	return /\.[\w-]/.test(selector);
}

function selectorUsesId(selector: string): boolean {
	return /#[\w-]/.test(selector);
}

// --- Main matching ---

function determineMatchType(
	elementNode: MatchNode,
	spine: ContextSpine,
	selector: string,
): 'definite' | 'conditional' | 'dynamic' {
	// Check dynamic: does selector reference class/id and the element has dynamic class/id?
	const hasDynamicClass = elementNode.dynamicAttrs.includes('class');
	const hasDynamicId = elementNode.dynamicAttrs.includes('id');
	if ((hasDynamicClass && selectorUsesClass(selector)) ||
		(hasDynamicId && selectorUsesId(selector))) {
		return 'dynamic';
	}

	// Check conditional: any ancestor is conditional
	if (spine.isConditional || elementNode.isConditional) {
		return 'conditional';
	}

	return 'definite';
}

/** Collect all element MatchNodes in a subtree (including the root). */
function collectAllNodes(node: MatchNode): MatchNode[] {
	const out: MatchNode[] = [];
	function walk(n: MatchNode) {
		if (isTag(n)) out.push(n);
		for (const child of n.children) walk(child);
	}
	walk(node);
	return out;
}

export function matchSelectors(
	rules: CssRule[],
	partialRoots: Map<string, { roots: MatchNode[]; file: string; partialName: string }>,
	spinesCache: Map<string, ContextSpine[]>,
): Map<string, ElementMatches[]> {
	const result = new Map<string, ElementMatches[]>();

	for (const [partialName, partial] of partialRoots) {
		const spines = spinesCache.get(partialName) ?? [{ ancestors: [], isConditional: false }];

		// Per-element match accumulator: sourceElement -> { matchedRules, seenKeys }
		const elementMatchMap = new Map<MatchNode, { seen: Set<string>; matches: MatchedRule[] }>();

		// For each root subtree, graft it onto each spine and test all elements
		for (const rootNode of partial.roots) {
			for (const spine of spines) {
				const cloned = cloneMatchNode(rootNode);
				graftOntoSpine(cloned, spine);

				// Walk all elements in the grafted tree
				const allNodes = collectAllNodes(cloned);
				for (const node of allNodes) {
					// Find the original MatchNode this was cloned from (by sourceElement identity)
					const origKey = node.sourceElement
						? findOriginalNode(rootNode, node.sourceElement)
						: node;
					if (!origKey) continue;

					let entry = elementMatchMap.get(origKey);
					if (!entry) {
						entry = { seen: new Set(), matches: [] };
						elementMatchMap.set(origKey, entry);
					}

					for (const rule of rules) {
						for (const selector of rule.selectors) {
							const key = `${selector}:${rule.sourceLine}:${rule.sourceCol}`;
							if (entry.seen.has(key)) continue;

							try {
								if (cssIs(node, selector, { adapter: adapter as any, cacheResults: false })) {
									entry.seen.add(key);
									entry.matches.push({
										rule,
										selector,
										specificity: getSpecificity(selector),
										mediaConditions: rule.mediaConditions,
										matchType: determineMatchType(node, spine, selector),
									});
								}
							} catch {
								// Skip invalid selectors
							}
						}
					}
				}
			}
		}

		// Convert accumulated matches to result
		for (const [origNode, { matches }] of elementMatchMap) {
			if (matches.length === 0) continue;

			matches.sort((a, b) => {
				for (let i = 0; i < 3; i++) {
					if (b.specificity[i] !== a.specificity[i]) {
						return b.specificity[i] - a.specificity[i];
					}
				}
				return 0;
			});

			const loc = origNode.sourceElement?.sourceCodeLocation;
			const entry: ElementMatches = {
				element: origNode.sourceElement!,
				file: partial.file,
				partialName: partial.partialName,
				startLine: loc?.startLine ?? 0,
				startCol: loc?.startCol ?? 0,
				startOffset: loc?.startOffset ?? 0,
				matches,
			};

			const existing = result.get(partial.file);
			if (existing) {
				existing.push(entry);
			} else {
				result.set(partial.file, [entry]);
			}
		}
	}

	return result;
}

/** Find a MatchNode in the original tree by sourceElement reference. */
function findOriginalNode(root: MatchNode, sourceElement: Element): MatchNode | null {
	if (root.sourceElement === sourceElement) return root;
	for (const child of root.children) {
		const found = findOriginalNode(child, sourceElement);
		if (found) return found;
	}
	return null;
}

function cloneMatchNode(node: MatchNode): MatchNode {
	const clone: MatchNode = {
		kind: node.kind,
		tagName: node.tagName,
		attrs: [...node.attrs],
		dynamicAttrs: [...node.dynamicAttrs],
		isConditional: node.isConditional,
		children: [],
		parent: null,
		sourceElement: node.sourceElement,
	};
	for (const child of node.children) {
		const childClone = cloneMatchNode(child);
		childClone.parent = clone;
		clone.children.push(childClone);
	}
	return clone;
}

// --- Public helpers for building MatchNodes from parsed templates ---

export { MatchNode, matchNodeFromElement, adapter };
