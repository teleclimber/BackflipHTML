import type { Hover, Position } from 'vscode-languageserver';
import { MarkupKind } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { ProjectIndex, PartialDef } from './index.js';
import type { CssAnalysisResult } from '@backflip/css';
import type { DataShape } from '@backflip/html';
import { parseBPartValue } from './parse-bpart.js';
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
	stylesheetPath?: string | null,
	templateRoot?: string | null,
): Hover | null {
	const line = doc.getText({
		start: { line: position.line, character: 0 },
		end: { line: position.line + 1, character: 0 },
	});

	return hoverCssSelector(line, position, filePath, cssAnalysis, stylesheetPath, templateRoot)
		?? hoverBPart(line, position, filePath, index)
		?? hoverBName(line, position, filePath, index)
		?? hoverBIn(doc, line, position, filePath, index)
		?? hoverBSlot(doc, line, position, filePath, index)
		?? hoverBData(line, position, filePath, index)
		?? hoverCssRules(line, position, filePath, cssAnalysis, stylesheetPath)
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
	if (def.dataShape && def.dataShape.size > 0) {
		return formatDataShape(def.dataShape);
	}
	return formatFreeVars(def.freeVars);
}

function formatDataShape(shapes: Map<string, DataShape>): string {
	if (shapes.size === 0) return '**Data:** none';
	const entries: string[] = [];
	for (const [name, shape] of shapes) {
		entries.push(`\`${name}\` — ${describeShape(name, shape)}`);
	}
	return `**Data:**  \n${entries.join('  \n')}`;
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

// --- b-part hover ---

function hoverBPart(
	line: string, position: Position, filePath: string, index: ProjectIndex,
): Hover | null {
	const value = matchAttr(line, 'b-part', position.character);
	if (value === null) return null;

	const { partialName, targetFile } = parseBPartValue(value);
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

	const { partialName, targetFile } = parseBPartValue(partialInfo);
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
	line: string, position: Position, filePath: string, index: ProjectIndex,
): Hover | null {
	// Match b-data:varname="..." — cursor can be on the attribute name or value
	const regex = /b-data:([a-zA-Z_][a-zA-Z0-9_]*)="([^"]*)"/g;
	let m;
	while ((m = regex.exec(line)) !== null) {
		const fullStart = m.index;
		const fullEnd = fullStart + m[0].length;
		if (position.character < fullStart || position.character > fullEnd) continue;

		const varName = m[1];

		// Find b-part on the same line
		const bPartMatch = line.match(/b-part="([^"]*)"/);
		if (!bPartMatch) {
			return mkHover([`**Data** \`${varName}\` — *no b-part on this element*`]);
		}

		const { partialName, targetFile } = parseBPartValue(bPartMatch[1]);
		const def = resolvePartialDef(partialName, targetFile, filePath, index);

		if (!def) {
			return mkHover([`**Data** \`${varName}\` → partial \`${partialName}\` — *partial not found*`]);
		}

		const used = def.freeVars.includes(varName);
		const lines: string[] = [];
		lines.push(`**Data** \`${varName}\` → partial \`${partialName}\``);
		lines.push(used ? '✓ Used in partial' : '✗ Not used in partial');
		return mkHover(lines);
	}

	return null;
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
	stylesheetPath: string,
	templateRoot: string,
): ElementMatchInfo[] | null {
	const relStylesheet = path.relative(templateRoot, stylesheetPath);
	if (filePath !== relStylesheet && filePath !== stylesheetPath) return null;

	const lspLine = lspLine0 + 1; // convert to 1-based

	const matchingElements: ElementMatchInfo[] = [];

	for (const [_file, elements] of cssAnalysis.elementMatches) {
		for (const el of elements) {
			for (const m of el.matches) {
				if (m.rule.sourceLine === lspLine) {
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
	stylesheetPath?: string | null,
	templateRoot?: string | null,
): Hover | null {
	if (!cssAnalysis || !stylesheetPath || !templateRoot) return null;

	const unique = findElementsForSelector(filePath, position.line, cssAnalysis, stylesheetPath, templateRoot);
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
		lines.push(`\`${el.file}\` **${el.partialName}** · [line ${el.startLine}](command:backflipHTML.openCssRule?${args})${typeTag}`);
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
	stylesheetPath?: string | null,
): Hover | null {
	if (!cssAnalysis) return null;

	const result = findRulesForElement(line, position.line, position.character, filePath, cssAnalysis);
	if (!result) return null;

	const ruleCount = result.rules.length;
	const lines: string[] = [];
	lines.push(`**CSS Rules** (${ruleCount} rule${ruleCount !== 1 ? 's' : ''})`);
	lines.push('');

	for (const m of result.rules) {
		const spec = `(${m.specificity.join(', ')})`;
		const typeTag = m.matchType !== 'definite' ? ` · *${m.matchType}*` : '';

		let locationLink = '';
		if (stylesheetPath && m.sourceLine > 0) {
			const fileName = path.basename(stylesheetPath);
			const args = encodeURIComponent(JSON.stringify({
				path: stylesheetPath,
				line: m.sourceLine - 1,
				col: m.sourceCol - 1,
			}));
			locationLink = ` · [${fileName}:${m.sourceLine}](command:backflipHTML.openCssRule?${args})`;
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
