import type { Hover, Position } from 'vscode-languageserver';
import { MarkupKind } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { ProjectIndex, PartialDef } from './index.js';
import type { CssAnalysisResult } from '@backflip/css';
import type { DataShape } from '@backflip/html';
import { parseBPartValue } from '@backflip/html';
import * as path from 'node:path';

/**
 * Provide hover info for BackflipHTML b-directives.
 */
export function getHover(
	doc: TextDocument,
	position: Position,
	filePath: string,
	index: ProjectIndex,
	cssAnalysis?: CssAnalysisResult | null,
	cssPaths?: string[] | null,
	templateRoot?: string | null,
	assetDirs?: Map<string, string> | null,
): Hover | null {
	const line = doc.getText({
		start: { line: position.line, character: 0 },
		end: { line: position.line + 1, character: 0 },
	});

	return hoverCssSelector(line, position, filePath, cssAnalysis, cssPaths, templateRoot)
		?? hoverAssetRef(line, position, assetDirs)
		?? hoverBPart(line, position, filePath, index)
		?? hoverBName(line, position, filePath, index)
		?? hoverBIn(doc, line, position, filePath, index)
		?? hoverBSlot(doc, line, position, filePath, index)
		?? hoverBData(doc, line, position, filePath, index)
		?? hoverBAttrCallSite(doc, line, position, filePath, index)
		?? hoverCustomElement(line, position, filePath, index)
		?? hoverCssRules(line, position, filePath, cssAnalysis, cssPaths)
		?? null;
}

/** Match an attribute like `name="value"` on a line, checking cursor is within value. */
function matchAttr(line: string, attrName: string, character: number): string | null {
	const regex = new RegExp(`${attrName}="([^"]*)"`);
	const m = line.match(regex);
	if (!m) return null;
	const attrStart = line.indexOf(m[0]);
	const valueStart = attrStart + attrName.length + 2; // after ="
	const valueEnd = valueStart + m[1].length;
	if (character < valueStart || character > valueEnd) return null;
	return m[1];
}

/** Match a bare attribute (no value) like `b-slot` checking cursor is on it. */
function matchBareAttr(line: string, attrName: string, character: number): boolean {
	// Match the attribute name not followed by =
	const regex = new RegExp(`\\b${attrName}\\b(?!=)`);
	const m = line.match(regex);
	if (!m || m.index === undefined) return false;
	return character >= m.index && character <= m.index + attrName.length;
}

function resolvePartialDef(
	partialName: string,
	targetFile: string | null,
	sourceFile: string,
	index: ProjectIndex,
): PartialDef | null {
	const defs = index.partialDefs.get(partialName);
	if (!defs || defs.length === 0) return null;
	const resolvedFile = targetFile ?? sourceFile;
	return defs.find(d => d.file === resolvedFile) ?? null;
}

function countRefs(partialName: string, defFile: string, index: ProjectIndex): number {
	let count = 0;
	for (const ref of index.partialRefs) {
		if (ref.partialName !== partialName) continue;
		const isMatch = ref.targetFile === null
			? ref.file === defFile
			: ref.targetFile === defFile;
		if (isMatch) count++;
	}
	return count;
}

function formatSlots(slots: string[]): string {
	if (slots.length === 0) return '**Slots:** none';
	return `**Slots:** ${slots.map(s => `\`${s}\``).join(', ')}`;
}

function formatFreeVars(freeVars: string[]): string {
	if (freeVars.length === 0) return '**Data:** none';
	return `**Data:** ${freeVars.map(v => `\`${v}\``).join(', ')}`;
}

function formatDataInfo(def: PartialDef): string {
	const exclude = new Set(def.bAttrs?.map(a => a.name) ?? []);
	if (def.dataShape && def.dataShape.size > 0) {
		return formatDataShape(def.dataShape, exclude);
	}
	return formatFreeVars(def.freeVars.filter(v => !exclude.has(v)));
}

function formatDataShape(shapes: Map<string, DataShape>, exclude?: Set<string>): string {
	const entries: string[] = [];
	for (const [name, shape] of shapes) {
		if (exclude && exclude.has(name)) continue;
		entries.push(`\`${name}\` — ${describeShape(name, shape)}`);
	}
	if (entries.length === 0) return '**Data:** none';
	return `**Data:**  \n${entries.join('  \n')}`;
}

function formatAttributes(def: PartialDef): string | null {
	if (!def.bAttrs || def.bAttrs.length === 0) return null;
	const entries: string[] = [];
	for (const attr of def.bAttrs) {
		const typeStr = attr.isBool ? 'bool' : 'string';
		const shape = def.dataShape?.get(attr.name);
		let suffix = '';
		if (shape) {
			const desc = describeShape(attr.name, shape);
			if (desc && desc !== 'used') suffix = ` · ${desc}`;
		}
		entries.push(`\`${attr.name}\` — ${typeStr}${suffix}`);
	}
	return `**Attributes:**  \n${entries.join('  \n')}`;
}

function describeShape(_name: string, shape: DataShape): string {
	const parts: string[] = [];

	// Own usages
	if (shape.usages.size > 0) {
		for (const usage of shape.usages) {
			if (usage === 'attribute' && shape.attributes && shape.attributes.size > 0) {
				parts.push(`attribute: ${[...shape.attributes].join(', ')}`);
			} else if (usage === 'passed' && shape.passedTo && shape.passedTo.length > 0) {
				for (const p of shape.passedTo) {
					parts.push(`passed → ${p.partial}.${p.as}`);
				}
			} else {
				parts.push(usage);
			}
		}
	}

	if (shape.indexed) {
		parts.push('indexed');
	}

	// Element shape summary
	if (shape.elementShape) {
		const elDesc = describeShapeBrief(shape.elementShape);
		if (elDesc) parts.push(`element: ${elDesc}`);
	}

	// Properties — flatten with dot notation
	if (shape.properties && shape.properties.size > 0) {
		for (const [prop, propShape] of shape.properties) {
			const propParts = flattenProperties(prop, propShape);
			parts.push(...propParts);
		}
	}

	return parts.join(' · ') || 'used';
}

function describeShapeBrief(shape: DataShape): string {
	const parts: string[] = [];
	if (shape.usages.size > 0) parts.push([...shape.usages].join(', '));
	if (shape.properties && shape.properties.size > 0) {
		parts.push(`{${[...shape.properties.keys()].join(', ')}}`);
	}
	return parts.join(' ') || '';
}

function flattenProperties(prefix: string, shape: DataShape): string[] {
	const results: string[] = [];

	// Leaf: has own usages
	if (shape.usages.size > 0) {
		const usageStr = describeLeafUsages(shape);
		results.push(`.${prefix} (${usageStr})`);
	}

	// Recurse into sub-properties
	if (shape.properties && shape.properties.size > 0) {
		for (const [prop, propShape] of shape.properties) {
			results.push(...flattenProperties(`${prefix}.${prop}`, propShape));
		}
	}

	// If no usages and no sub-properties, just note it exists
	if (results.length === 0) {
		results.push(`.${prefix}`);
	}

	return results;
}

function describeLeafUsages(shape: DataShape): string {
	const parts: string[] = [];
	for (const usage of shape.usages) {
		if (usage === 'attribute' && shape.attributes && shape.attributes.size > 0) {
			parts.push(`attribute: ${[...shape.attributes].join(', ')}`);
		} else if (usage === 'passed' && shape.passedTo && shape.passedTo.length > 0) {
			for (const p of shape.passedTo) {
				parts.push(`passed → ${p.partial}.${p.as}`);
			}
		} else {
			parts.push(usage);
		}
	}
	return parts.join(', ');
}

function mkHover(lines: string[]): Hover {
	return {
		contents: {
			kind: MarkupKind.Markdown,
			value: lines.filter(l => l !== '').join('  \n'),
		},
	};
}

// --- asset ref hover ---

function hoverAssetRef(
	line: string,
	position: Position,
	assetDirs?: Map<string, string> | null,
): Hover | null {
	if (!assetDirs || assetDirs.size === 0) return null;

	// Match attributes with ~ suffix: attr~="value" or attr~='value' or :attr~="..."
	const regex = /:?([a-zA-Z][a-zA-Z0-9-]*)~=(["'])([^"']*)\2/g;
	let m;
	while ((m = regex.exec(line)) !== null) {
		const attrStart = m.index;
		const attrEnd = attrStart + m[0].length;
		if (position.character < attrStart || position.character > attrEnd) continue;

		const attrName = m[1];
		const quote = m[2];
		const value = m[3];
		const valueStart = m.index + m[0].indexOf(quote) + 1;

		// Find which @name the cursor is on
		const assetRefRegex = /@([a-zA-Z0-9_-]+)\//g;
		let refMatch;
		while ((refMatch = assetRefRegex.exec(value)) !== null) {
			const refStart = valueStart + refMatch.index;
			// Find end of this asset path (next comma for srcset, or end of value)
			const afterRef = refMatch.index + refMatch[0].length;
			const rest = value.substring(afterRef);
			const subpath = attrName === 'srcset'
				? rest.split(',')[0].split(/\s/)[0]
				: rest;
			const refEnd = valueStart + afterRef + subpath.length;

			if (position.character >= refStart && position.character <= refEnd) {
				const dirName = refMatch[1];
				const dirPath = assetDirs.get(dirName);
				if (!dirPath) {
					return mkHover([`**Asset** \`@${dirName}\` — *unknown asset directory*`]);
				}
				const resolvedPath = path.join(dirPath, subpath);
				const lines: string[] = [];
				lines.push(`**Asset** \`@${dirName}/${subpath}\``);
				lines.push(`**Directory:** \`${dirPath}\``);
				lines.push(`**File:** \`${resolvedPath}\``);
				return mkHover(lines);
			}
		}

		// Cursor is on the ~= attribute but not on a specific @ref
		return mkHover([`**Asset attribute** \`${attrName}~\``]);
	}

	return null;
}

// --- b-part hover ---

function hoverBPart(
	line: string, position: Position, filePath: string, index: ProjectIndex,
): Hover | null {
	const value = matchAttr(line, 'b-part', position.character);
	if (value === null) return null;

	const { partialName, file: targetFile } = parseBPartValue(value);
	const def = resolvePartialDef(partialName, targetFile, filePath, index);

	if (!def) {
		return mkHover([`**Partial** \`${partialName}\` — *not found*`]);
	}

	const lines: string[] = [];
	const fileInfo = targetFile ? ` — \`${def.file}\`` : '';
	const exportInfo = def.exported ? ' · exported' : '';
	lines.push(`**Partial** \`${partialName}\`${fileInfo}${exportInfo}`);
	lines.push(formatSlots(def.slots));
	lines.push(formatDataInfo(def));
	return mkHover(lines);
}

// --- b-name hover ---

function hoverBName(
	line: string, position: Position, filePath: string, index: ProjectIndex,
): Hover | null {
	const value = matchAttr(line, 'b-name', position.character);
	if (value === null) return null;

	const def = resolvePartialDef(value, null, filePath, index);
	if (!def) {
		return mkHover([`**Partial** \`${value}\` — *definition not indexed*`]);
	}

	const refCount = countRefs(value, def.file, index);
	const lines: string[] = [];
	const exportInfo = def.exported ? 'Exported' : 'Local';
	lines.push(`**Partial** \`${value}\``);
	lines.push(`${exportInfo} · ${refCount} reference${refCount !== 1 ? 's' : ''}`);
	lines.push(formatSlots(def.slots));
	lines.push(formatDataInfo(def));
	return mkHover(lines);
}

// --- b-in hover ---

function hoverBIn(
	doc: TextDocument, line: string, position: Position, filePath: string, index: ProjectIndex,
): Hover | null {
	const value = matchAttr(line, 'b-in', position.character);
	if (value === null) return null;

	const slotName = value || 'default';

	// Scan upward to find the enclosing b-part
	const partialInfo = scanUpFor(doc, position.line, /b-part="([^"]*)"/);
	if (!partialInfo) {
		return mkHover([`**Slot** \`${slotName}\` — *enclosing b-part not found*`]);
	}

	const { partialName, file: targetFile } = parseBPartValue(partialInfo);
	const def = resolvePartialDef(partialName, targetFile, filePath, index);

	if (!def) {
		return mkHover([`**Slot** \`${slotName}\` → partial \`${partialName}\` — *partial not found*`]);
	}

	const exists = def.slots.includes(slotName);
	const lines: string[] = [];
	lines.push(`**Slot** \`${slotName}\` → partial \`${partialName}\``);
	if (exists) {
		lines.push('✓ Slot exists');
	} else {
		const available = def.slots.length > 0
			? ` (available: ${def.slots.map(s => `\`${s}\``).join(', ')})`
			: ' (no slots defined)';
		lines.push(`✗ Slot not found${available}`);
	}
	return mkHover(lines);
}

// --- b-slot hover ---

function hoverBSlot(
	doc: TextDocument, line: string, position: Position, filePath: string, index: ProjectIndex,
): Hover | null {
	// Try b-slot="value" first, then bare b-slot
	const value = matchAttr(line, 'b-slot', position.character);
	const isBare = value === null && matchBareAttr(line, 'b-slot', position.character);

	if (value === null && !isBare) return null;

	const slotName = value || 'default';

	// Scan upward to find the enclosing b-name
	const partialName = scanUpFor(doc, position.line, /b-name="([^"]*)"/);
	if (!partialName) {
		return mkHover([`**Slot** \`${slotName}\` — *enclosing b-name not found*`]);
	}

	return mkHover([`**Slot** \`${slotName}\` in partial \`${partialName}\``]);
}

// --- b-data: hover ---

function hoverBData(
	doc: TextDocument, line: string, position: Position, filePath: string, index: ProjectIndex,
): Hover | null {
	// Match b-data:varname="..." — cursor can be on the attribute name or value
	const regex = /b-data:([a-zA-Z_][a-zA-Z0-9_]*)="([^"]*)"/g;
	let m;
	while ((m = regex.exec(line)) !== null) {
		const fullStart = m.index;
		const fullEnd = fullStart + m[0].length;
		if (position.character < fullStart || position.character > fullEnd) continue;

		const varName = m[1];

		const partialCtx = findCallSitePartial(doc, position, filePath, index);
		if (!partialCtx) {
			return mkHover([`**Data** \`${varName}\` — *no enclosing partial reference*`]);
		}

		const { partialName, def } = partialCtx;
		if (!def) {
			return mkHover([`**Data** \`${varName}\` → partial \`${partialName}\` — *partial not found*`]);
		}

		// On a custom element call site, b-data:NAME conflicts with a declared b-attr:NAME
		// (compiler error). Surface this in the hover.
		if (def.bAttrs?.some(a => a.name === varName)) {
			return mkHover([
				`**Data** \`${varName}\` → partial \`${partialName}\``,
				`✗ Conflicts with declared \`b-attr:${varName}\` — pass as an attribute instead`,
			]);
		}

		const used = def.freeVars.includes(varName);
		const lines: string[] = [];
		lines.push(`**Data** \`${varName}\` → partial \`${partialName}\``);
		lines.push(used ? '✓ Used in partial' : '✗ Not used in partial');
		return mkHover(lines);
	}

	return null;
}

/**
 * Resolve the partial reference for the opening tag enclosing the cursor.
 * Recognises both `<element b-part="...">` and a custom-element tag.
 * Walks up across lines to support multi-line opening tags.
 */
function findCallSitePartial(
	doc: TextDocument, position: Position, filePath: string, index: ProjectIndex,
): { partialName: string; def: PartialDef | null } | null {
	const tag = findEnclosingOpeningTag(doc, position.line, position.character);
	if (!tag) return null;

	const bPartMatch = tag.openTagText.match(/b-part="([^"]*)"/);
	if (bPartMatch) {
		const { partialName, file: targetFile } = parseBPartValue(bPartMatch[1]);
		return { partialName, def: resolvePartialDef(partialName, targetFile, filePath, index) };
	}

	if (tag.tagName.includes('-') && !tag.tagName.startsWith('b-')) {
		const defs = index.partialDefs.get(tag.tagName);
		const def = defs?.find(d => d.customElement) ?? null;
		if (def) return { partialName: tag.tagName, def };
	}

	return null;
}

/**
 * Mask quoted attribute values with spaces so embedded `<` or `>` don't confuse
 * a tag-boundary scan. Lengths are preserved.
 */
function maskQuoted(s: string): string {
	return s
		.replace(/"[^"]*"/g, m => ' '.repeat(m.length))
		.replace(/'[^']*'/g, m => ' '.repeat(m.length));
}

/**
 * Find the opening tag whose attribute area contains the cursor. Walks back up
 * to ~50 lines and forward up to ~50 lines so multi-line opening tags resolve.
 * Returns the tag name and the opening-tag text (`<TAG ... >` or partial if `>`
 * not found within the lookahead window).
 */
function findEnclosingOpeningTag(
	doc: TextDocument, lineIdx: number, character: number,
): { tagName: string; openTagText: string } | null {
	const maxLookback = 50;
	const maxLookahead = 50;
	const startLine = Math.max(0, lineIdx - maxLookback);
	const before = doc.getText({
		start: { line: startLine, character: 0 },
		end: { line: lineIdx, character },
	});
	const beforeMasked = maskQuoted(before);
	const lastGt = beforeMasked.lastIndexOf('>');
	const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)/g;
	let lastMatch: RegExpExecArray | null = null;
	let m: RegExpExecArray | null;
	while ((m = tagRe.exec(beforeMasked)) !== null) lastMatch = m;
	if (!lastMatch) return null;
	if (lastGt > lastMatch.index) return null; // tag closed before cursor

	const after = doc.getText({
		start: { line: lineIdx, character },
		end: { line: lineIdx + maxLookahead, character: 0 },
	});
	const afterMasked = maskQuoted(after);
	const closeIdx = afterMasked.indexOf('>');
	const afterPart = closeIdx !== -1 ? after.substring(0, closeIdx + 1) : after;

	return {
		tagName: lastMatch[1],
		openTagText: before.substring(lastMatch.index) + afterPart,
	};
}

// --- b-attr at call site (plain, :attr, b-bind:attr) ---

function hoverBAttrCallSite(
	doc: TextDocument, line: string, position: Position, filePath: string, index: ProjectIndex,
): Hover | null {
	const attrName = findAttrNameAtCursor(line, position.character);
	if (!attrName) return null;

	const tag = findEnclosingOpeningTag(doc, position.line, position.character);
	if (!tag) return null;
	if (!tag.tagName.includes('-') || tag.tagName.startsWith('b-')) return null;

	const defs = index.partialDefs.get(tag.tagName);
	if (!defs) return null;
	const def = defs.find(d => d.customElement);
	if (!def) return null;

	const bAttr = def.bAttrs?.find(a => a.name === attrName);
	if (!bAttr) return null;

	const typeStr = bAttr.isBool ? 'bool' : 'string';
	const shape = def.dataShape?.get(bAttr.name);
	let suffix = '';
	if (shape) {
		const desc = describeShape(bAttr.name, shape);
		if (desc && desc !== 'used') suffix = ` · ${desc}`;
	}
	return mkHover([
		`**Attribute** \`${attrName}\` → partial \`${tag.tagName}\``,
		`Type: ${typeStr}${suffix}`,
	]);
}

/**
 * Find the attribute name at the cursor on a line. Recognises `b-bind:NAME[.mod]`,
 * `:NAME[.mod]`, and plain `NAME` attributes (with or without a `="value"`).
 * Returns the bare attribute name (without prefix or modifier).
 */
function findAttrNameAtCursor(line: string, character: number): string | null {
	const valuePart = `(?:\\s*=\\s*"[^"]*")?`;

	// b-bind:NAME[.mod][="..."]
	const bbindRe = new RegExp(`b-bind:([a-zA-Z_][a-zA-Z0-9_-]*)(?:\\.[\\w-]+)?${valuePart}`, 'g');
	let m: RegExpExecArray | null;
	while ((m = bbindRe.exec(line)) !== null) {
		if (character >= m.index && character <= m.index + m[0].length) return m[1];
	}

	// :NAME[.mod][="..."] — the colon must not follow a word char or hyphen
	const colonRe = new RegExp(`(?<![\\w-]):([a-zA-Z_][a-zA-Z0-9_-]*)(?:\\.[\\w-]+)?${valuePart}`, 'g');
	while ((m = colonRe.exec(line)) !== null) {
		if (character >= m.index && character <= m.index + m[0].length) return m[1];
	}

	// Plain attribute: whitespace-then-name, optionally followed by ="..."
	const plainRe = new RegExp(`\\s([a-zA-Z][\\w-]*)${valuePart}`, 'g');
	while ((m = plainRe.exec(line)) !== null) {
		if (m[1].startsWith('b-')) continue;
		const nameStart = m.index + 1;
		const matchEnd = m.index + m[0].length;
		if (character >= nameStart && character <= matchEnd) return m[1];
	}

	return null;
}

// --- custom element partial hover (call site or definition site) ---

export function findCustomElementTagAtCursor(
	line: string, character: number,
): { tagName: string; isClosing: boolean } | null {
	const regex = /<(\/?)([a-z][a-zA-Z0-9-]*)/g;
	let m: RegExpExecArray | null;
	while ((m = regex.exec(line)) !== null) {
		const tagName = m[2];
		if (!tagName.includes('-')) continue;
		if (tagName.startsWith('b-')) continue;
		const nameStart = m.index + 1 + m[1].length; // after '<' or '</'
		const nameEnd = nameStart + tagName.length;
		if (character >= nameStart && character <= nameEnd) {
			return { tagName, isClosing: m[1] === '/' };
		}
	}
	return null;
}

function hoverCustomElement(
	line: string, position: Position, filePath: string, index: ProjectIndex,
): Hover | null {
	const tagInfo = findCustomElementTagAtCursor(line, position.character);
	if (!tagInfo) return null;
	const { tagName, isClosing } = tagInfo;

	const defs = index.partialDefs.get(tagName);
	if (!defs || defs.length === 0) return null;
	const def = defs.find(d => d.customElement);
	if (!def) return null;

	const isDefSite = !isClosing
		&& def.file === filePath
		&& def.loc != null
		&& def.loc.startLine === position.line + 1;

	const lines: string[] = [];
	if (isDefSite) {
		const refCount = countRefs(tagName, def.file, index);
		const exportInfo = def.exported ? 'Exported' : 'Local';
		lines.push(`**Custom element partial** \`<${tagName}>\``);
		lines.push(`${exportInfo} · ${refCount} reference${refCount !== 1 ? 's' : ''}`);
	} else {
		const fileInfo = def.file !== filePath ? ` — \`${def.file}\`` : '';
		const exportInfo = def.exported ? ' · exported' : '';
		lines.push(`**Custom element partial** \`<${tagName}>\`${fileInfo}${exportInfo}`);
	}
	lines.push(formatSlots(def.slots));
	const attrLine = formatAttributes(def);
	if (attrLine) lines.push(attrLine);
	lines.push(formatDataInfo(def));
	return mkHover(lines);
}

// --- CSS selector hover (in stylesheet) ---

export interface ElementMatchInfo {
	file: string;
	partialName: string;
	startLine: number;
	startCol: number;
	matchType: string;
}

/**
 * Find all HTML elements that match a CSS rule at the given line.
 * Shared by hover and "Find All Matches" panel.
 */
export function findElementsForSelector(
	filePath: string,
	lspLine0: number,
	cssAnalysis: CssAnalysisResult,
	cssPaths: string[],
	templateRoot: string,
): ElementMatchInfo[] | null {
	// Which stylesheet is this? Rules carry the absolute path they were parsed
	// from, so the line alone is not enough to identify a rule — two stylesheets
	// both have a line 12.
	const cssPath = cssPaths.find(p => {
		const rel = path.relative(templateRoot, p);
		return filePath === rel || filePath === p;
	});
	if (!cssPath) return null;

	const lspLine = lspLine0 + 1; // convert to 1-based

	const matchingElements: ElementMatchInfo[] = [];

	for (const [_file, elements] of cssAnalysis.elementMatches) {
		for (const el of elements) {
			for (const m of el.matches) {
				if (m.rule.sourceFile === cssPath && m.rule.sourceLine === lspLine) {
					matchingElements.push({
						file: el.file,
						partialName: el.partialName,
						startLine: el.startLine,
						startCol: el.startCol,
						matchType: m.matchType,
					});
				}
			}
		}
	}

	if (matchingElements.length === 0) return null;

	// Deduplicate by file + partialName + startLine
	const seen = new Set<string>();
	return matchingElements.filter(e => {
		const key = `${e.file}:${e.partialName}:${e.startLine}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function hoverCssSelector(
	line: string,
	position: Position,
	filePath: string,
	cssAnalysis?: CssAnalysisResult | null,
	cssPaths?: string[] | null,
	templateRoot?: string | null,
): Hover | null {
	if (!cssAnalysis || !cssPaths || cssPaths.length === 0 || !templateRoot) return null;

	const unique = findElementsForSelector(filePath, position.line, cssAnalysis, cssPaths, templateRoot);
	if (!unique) return null;

	const partialSet = new Set(unique.map(e => `${e.file}#${e.partialName}`));
	const partialCount = partialSet.size;
	const matchCount = unique.length;

	const lines: string[] = [];
	lines.push(`**Matched elements** (${matchCount} match${matchCount !== 1 ? 'es' : ''} in ${partialCount} partial${partialCount !== 1 ? 's' : ''})`);
	lines.push('');

	for (const el of unique) {
		const typeTag = el.matchType !== 'definite' ? ` · *${el.matchType}*` : '';
		const fullPath = path.join(templateRoot, el.file);
		const args = encodeURIComponent(JSON.stringify({
			path: fullPath,
			line: el.startLine - 1,
			col: el.startCol - 1,
		}));
		lines.push(`\`${el.file}\` **${el.partialName}** · [line ${el.startLine}](command:backflipHTML.openFileAtLocation?${args})${typeTag}`);
	}

	return mkHover(lines);
}

// --- CSS rules hover ---

export interface RuleMatchInfo {
	selector: string;
	specificity: [number, number, number];
	matchType: 'definite' | 'conditional' | 'dynamic';
	properties: Array<{ name: string; value: string }>;
	mediaConditions: string[];
	sourceLine: number;
	sourceCol: number;
}

export interface ElementRulesResult {
	tagName: string;
	file: string;
	partialName: string;
	startLine: number;
	startCol: number;
	rules: RuleMatchInfo[];
}

/**
 * Find all CSS rules that match an HTML element at the given position.
 * Shared by hover and "Find All Selectors" panel.
 */
export function findRulesForElement(
	line: string,
	lspLine0: number,
	character: number,
	filePath: string,
	cssAnalysis: CssAnalysisResult,
): ElementRulesResult | null {
	const matches = cssAnalysis.elementMatches.get(filePath);
	if (!matches) return null;

	const lspLine = lspLine0 + 1; // convert to 1-based

	const tagMatch = line.match(/<([a-zA-Z][\w-]*)/);
	if (!tagMatch) return null;

	const tagStart = line.indexOf(tagMatch[0]);

	const elementMatch = matches.find(m => {
		if (m.startLine !== lspLine) return false;
		return character >= tagStart;
	});

	if (!elementMatch || elementMatch.matches.length === 0) return null;

	return {
		tagName: tagMatch[1],
		file: elementMatch.file,
		partialName: elementMatch.partialName,
		startLine: elementMatch.startLine,
		startCol: elementMatch.startCol,
		rules: elementMatch.matches.map(m => ({
			selector: m.selector,
			specificity: m.specificity,
			matchType: m.matchType,
			properties: m.rule.properties.map(p => ({ name: p.name, value: p.value })),
			mediaConditions: m.mediaConditions,
			sourceLine: m.rule.sourceLine,
			sourceCol: m.rule.sourceCol,
		})),
	};
}

function hoverCssRules(
	line: string,
	position: Position,
	filePath: string,
	cssAnalysis?: CssAnalysisResult | null,
	cssPaths?: string[] | null,
): Hover | null {
	if (!cssAnalysis) return null;

	const result = findRulesForElement(line, position.line, position.character, filePath, cssAnalysis);
	if (!result) return null;

	const ruleCount = result.rules.length;
	const lines: string[] = [];
	lines.push(`**CSS Rules** (${ruleCount} rule${ruleCount !== 1 ? 's' : ''})`);
	lines.push('');

	// Use the first CSS path for location links (best effort)
	const primaryCssPath = cssPaths && cssPaths.length > 0 ? cssPaths[0] : null;

	for (const m of result.rules) {
		const spec = `(${m.specificity.join(', ')})`;
		const typeTag = m.matchType !== 'definite' ? ` · *${m.matchType}*` : '';

		let locationLink = '';
		if (primaryCssPath && m.sourceLine > 0) {
			const fileName = path.basename(primaryCssPath);
			const args = encodeURIComponent(JSON.stringify({
				path: primaryCssPath,
				line: m.sourceLine - 1,
				col: m.sourceCol - 1,
			}));
			locationLink = ` · [${fileName}:${m.sourceLine}](command:backflipHTML.openFileAtLocation?${args})`;
		}

		lines.push(`\`${m.selector}\` — ${spec}${typeTag}${locationLink}`);

		if (m.properties.length > 0) {
			const props = m.properties.map(p => `${p.name}: ${p.value}`).join('; ');
			lines.push(`  ${props}`);
		}

		if (m.mediaConditions.length > 0) {
			lines.push(`  @media ${m.mediaConditions.join(' and ')}`);
		}
	}

	return mkHover(lines);
}

// --- helpers ---

/** Scan upward from `startLine` (exclusive) looking for a regex match. Returns capture group 1. */
function scanUpFor(doc: TextDocument, startLine: number, regex: RegExp): string | null {
	const maxScan = 50; // don't scan more than 50 lines up
	for (let i = startLine - 1; i >= 0 && i >= startLine - maxScan; i--) {
		const prevLine = doc.getText({
			start: { line: i, character: 0 },
			end: { line: i + 1, character: 0 },
		});
		const m = prevLine.match(regex);
		if (m) return m[1];
	}
	return null;
}
