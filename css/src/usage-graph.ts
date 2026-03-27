import type {
	ParsedTemplate,
	Element,
	ChildNode,
	UsageGraph,
	PartialDefinition,
	PartialUsageSite,
	DirectiveMap,
	BDirectiveInfo,
} from './types.js';

function isElement(node: ChildNode): node is Element {
	return 'tagName' in node;
}

function walkSubtreeForSlots(
	node: Element,
	directives: DirectiveMap,
	slots: Map<string, Element>,
): void {
	if (!node.childNodes) return;
	for (const child of node.childNodes) {
		if (!isElement(child)) continue;
		const info = directives.get(child);
		if (info?.bSlot !== undefined) {
			slots.set(info.bSlot, child);
		}
		walkSubtreeForSlots(child, directives, slots);
	}
}

function findParentElement(element: Element): Element | null {
	const parent = (element as any).parentNode;
	if (parent && 'tagName' in parent) {
		return parent as Element;
	}
	return null;
}

function collectSlotInjections(
	element: Element,
	directives: DirectiveMap,
): Map<string, Element[]> {
	const injections = new Map<string, Element[]>();
	if (!element.childNodes) return injections;
	for (const child of element.childNodes) {
		if (!isElement(child)) continue;
		const info = directives.get(child);
		if (info?.bIn !== undefined) {
			const slotName = info.bIn;
			if (!injections.has(slotName)) {
				injections.set(slotName, []);
			}
			injections.get(slotName)!.push(child);
		}
	}
	return injections;
}

export function buildUsageGraph(templates: ParsedTemplate[]): UsageGraph {
	const definitions = new Map<string, PartialDefinition[]>();
	const usages = new Map<string, PartialUsageSite[]>();
	const fileElements = new Map<string, Element[]>();
	const mergedDirectives: DirectiveMap = new WeakMap();

	for (const template of templates) {
		// Build fileElements map
		fileElements.set(template.filePath, template.elements);

		// Merge directives
		for (const el of template.elements) {
			const info = template.directives.get(el);
			if (info) {
				mergedDirectives.set(el, info);
			}
		}

		// Process each element.
		// Track the containing b-name partial as we iterate in pre-order so
		// that usage sites know which lexical partial they belong to.
		const partialStack: { name: string; endOffset: number }[] = [];
		for (const el of template.elements) {
			const info = template.directives.get(el);

			// Pop partials whose subtree we've left
			const startOffset = el.sourceCodeLocation?.startOffset ?? 0;
			while (partialStack.length > 0 && startOffset >= partialStack[partialStack.length - 1].endOffset) {
				partialStack.pop();
			}

			if (!info) continue;

			if (info.bName) {
				const slotElements = new Map<string, Element>();
				walkSubtreeForSlots(el, template.directives, slotElements);

				const def: PartialDefinition = {
					name: info.bName,
					file: template.filePath,
					rootElement: el,
					slotElements,
				};

				if (!definitions.has(info.bName)) {
					definitions.set(info.bName, []);
				}
				definitions.get(info.bName)!.push(def);

				const endOffset = el.sourceCodeLocation?.endOffset ?? Infinity;
				partialStack.push({ name: info.bName, endOffset });
			}

			if (info.bPartParsed) {
				const slotInjections = collectSlotInjections(el, template.directives);
				const parentElement = findParentElement(el);
				const containingPartialName = partialStack.length > 0
					? partialStack[partialStack.length - 1].name
					: null;

				const site: PartialUsageSite = {
					file: template.filePath,
					element: el,
					partialName: info.bPartParsed.partialName,
					targetFile: info.bPartParsed.targetFile,
					parentElement,
					slotInjections,
					containingPartialName,
				};

				if (!usages.has(info.bPartParsed.partialName)) {
					usages.set(info.bPartParsed.partialName, []);
				}
				usages.get(info.bPartParsed.partialName)!.push(site);
			}
		}
	}

	return {
		definitions,
		usages,
		fileElements,
		directives: mergedDirectives,
	};
}
