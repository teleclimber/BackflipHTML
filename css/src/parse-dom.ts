import { parseFragment } from 'parse5';
import type { BDirectiveInfo, ParsedTemplate, Element, ChildNode, DirectiveMap, DocumentFragment } from './types.js';

function parseBPartValue(value: string): { partialName: string; targetFile: string | null } {
	const hashIdx = value.indexOf('#');
	if (hashIdx === -1) {
		return { partialName: value, targetFile: null };
	}
	const targetFile = value.slice(0, hashIdx) || null;
	const partialName = value.slice(hashIdx + 1);
	return { partialName, targetFile };
}

function getAttr(el: Element, name: string): string | undefined {
	const attr = el.attrs.find(a => a.name === name);
	return attr?.value;
}

function hasAttr(el: Element, name: string): boolean {
	return el.attrs.some(a => a.name === name);
}

function annotateElement(el: Element): BDirectiveInfo {
	const info: BDirectiveInfo = { dynamicAttrs: [] };

	for (const attr of el.attrs) {
		const { name, value } = attr;

		if (name === 'b-name') {
			info.bName = value;
		} else if (name === 'b-export') {
			info.bExport = true;
		} else if (name === 'b-part') {
			info.bPart = value;
			info.bPartParsed = parseBPartValue(value);
		} else if (name === 'b-for') {
			info.bFor = value;
		} else if (name === 'b-if') {
			info.bIf = value;
		} else if (name === 'b-else-if') {
			info.bElseIf = value;
		} else if (name === 'b-else') {
			info.bElse = true;
		} else if (name === 'b-slot') {
			info.bSlot = value || 'default';
		} else if (name === 'b-in') {
			info.bIn = value || 'default';
		} else if (name.startsWith('b-bind:')) {
			info.dynamicAttrs.push(name.slice(7));
		} else if (name.startsWith(':') && name.length > 1) {
			info.dynamicAttrs.push(name.slice(1));
		}
	}

	if (el.tagName === 'b-unwrap') {
		info.bUnwrap = true;
	}

	return info;
}

function isElement(node: ChildNode): node is Element {
	return 'tagName' in node;
}

function walkElements(nodes: ChildNode[], elements: Element[], directives: DirectiveMap): void {
	for (const node of nodes) {
		if (isElement(node)) {
			elements.push(node);
			directives.set(node, annotateElement(node));
			if (node.childNodes) {
				walkElements(node.childNodes, elements, directives);
			}
		}
	}
}

export function parseTemplate(html: string, filePath: string): ParsedTemplate {
	const fragment = parseFragment(html, { sourceCodeLocationInfo: true }) as DocumentFragment;
	const elements: Element[] = [];
	const directives: DirectiveMap = new WeakMap();

	walkElements(fragment.childNodes as ChildNode[], elements, directives);

	return { filePath, fragment, elements, directives };
}
