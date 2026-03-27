import { parse, parseFragment } from 'parse5';
import type { BDirectiveInfo, ParsedTemplate, Element, ChildNode, DirectiveMap, DocumentFragment, PartialSourceInfo } from './types.js';

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


export function parseTemplate(html: string, filePath: string, partialInfo: Map<string, PartialSourceInfo>): ParsedTemplate {
	// If any partial in this file is document-level, parse with parse() to handle
	// html/head/body tags correctly. Otherwise use parseFragment() as before.
	const hasDocumentLevel = Array.from(partialInfo.values()).some(info => info.isDocumentLevel);

	const elements: Element[] = [];
	const directives: DirectiveMap = new WeakMap();
	let childNodes: ChildNode[];
	let fragment: DocumentFragment;

	if (hasDocumentLevel) {
		const doc = parse(html, { sourceCodeLocationInfo: true });
		childNodes = doc.childNodes as ChildNode[];
		// Provide a dummy fragment for the interface
		fragment = parseFragment('', { sourceCodeLocationInfo: true }) as DocumentFragment;
	} else {
		fragment = parseFragment(html, { sourceCodeLocationInfo: true }) as DocumentFragment;
		childNodes = fragment.childNodes as ChildNode[];
	}

	walkElements(childNodes, elements, directives);

	return { filePath, fragment, elements, directives };
}

const DOCUMENT_LEVEL_TAGS = new Set(['html', 'head', 'body']);

/**
 * Build PartialSourceInfo from raw HTML by scanning for b-name tags.
 * Useful when compiler output is not available (e.g., in tests).
 */
export function buildPartialInfo(html: string): Map<string, PartialSourceInfo> {
	const info = new Map<string, PartialSourceInfo>();
	// Match opening tags with b-name attribute
	const tagRegex = /<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*\bb-name="([^"]*)"[^>]*>/g;
	let m: RegExpExecArray | null;
	while ((m = tagRegex.exec(html)) !== null) {
		const tagName = m[1].toLowerCase();
		const partialName = m[2];
		const startOffset = m.index;

		// Compute line/col of the match
		const before = html.substring(0, startOffset);
		const startLine = (before.match(/\n/g) ?? []).length + 1;
		const lastNl = before.lastIndexOf('\n');
		const startCol = lastNl === -1 ? startOffset + 1 : startOffset - lastNl;

		// Find the matching closing tag
		// For self-closing or void elements, end is the tag itself
		const voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
		let endOffset: number;
		if (voidElements.has(tagName) || m[0].endsWith('/>')) {
			endOffset = startOffset + m[0].length;
		} else {
			// Find matching close tag (simple: find </tagName>)
			const closeTag = `</${tagName}>`;
			const closeIdx = html.indexOf(closeTag, startOffset + m[0].length);
			endOffset = closeIdx !== -1 ? closeIdx + closeTag.length : startOffset + m[0].length;
		}

		// Check if the partial contains document-level tags
		const partialContent = html.substring(startOffset, endOffset);
		const isDocumentLevel = DOCUMENT_LEVEL_TAGS.has(tagName) ||
			/<(html|head|body)\b/i.test(partialContent.substring(m[0].length));

		info.set(partialName, { startOffset, endOffset, startLine, startCol, isDocumentLevel });
	}

	// If no b-name found, treat the whole file as a single fragment partial
	if (info.size === 0) {
		info.set('__root__', {
			startOffset: 0,
			endOffset: html.length,
			startLine: 1,
			startCol: 1,
			isDocumentLevel: false,
		});
	}

	return info;
}
