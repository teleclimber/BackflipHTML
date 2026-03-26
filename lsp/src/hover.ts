import type { Hover, Position } from 'vscode-languageserver';
import { MarkupKind } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { ProjectIndex, PartialDef } from './index.js';
import type { CssAnalysisResult } from '@backflip/css';
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
	lines.push(formatFreeVars(def.freeVars));
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
	lines.push(formatFreeVars(def.freeVars));
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

function hoverCssSelector(
	line: string,
	position: Position,
	filePath: string,
	cssAnalysis?: CssAnalysisResult | null,
	stylesheetPath?: string | null,
	templateRoot?: string | null,
): Hover | null {
	if (!cssAnalysis || !stylesheetPath || !templateRoot) return null;

	// Only activate when hovering in the stylesheet file
	const relStylesheet = path.relative(templateRoot, stylesheetPath);
	if (filePath !== relStylesheet && filePath !== stylesheetPath) return null;

	const lspLine = position.line + 1; // convert to 1-based

	// Collect all element matches whose rule sourceLine matches the hovered line
	const matchingElements: Array<{
		file: string;
		partialName: string;
		startLine: number;
		startCol: number;
		matchType: string;
	}> = [];

	for (const [file, elements] of cssAnalysis.elementMatches) {
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
	const unique = matchingElements.filter(e => {
		const key = `${e.file}:${e.partialName}:${e.startLine}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});

	// Count unique partials
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

function hoverCssRules(
	line: string,
	position: Position,
	filePath: string,
	cssAnalysis?: CssAnalysisResult | null,
	stylesheetPath?: string | null,
): Hover | null {
	if (!cssAnalysis) return null;

	const matches = cssAnalysis.elementMatches.get(filePath);
	if (!matches) return null;

	// Find an element match on this line (1-based line in parse5 vs 0-based in LSP)
	const lspLine = position.line + 1; // convert to 1-based

	// Check if cursor is on an HTML tag opening
	const tagMatch = line.match(/<([a-zA-Z][\w-]*)/);
	if (!tagMatch) return null;

	const tagStart = line.indexOf(tagMatch[0]);
	const tagEnd = tagStart + tagMatch[0].length;

	// Find the element match at this line that the cursor overlaps with
	// We look for elements whose start tag is on this line
	const elementMatch = matches.find(m => {
		if (m.startLine !== lspLine) return false;
		// Check if cursor is anywhere within the opening tag region
		return position.character >= tagStart;
	});

	if (!elementMatch || elementMatch.matches.length === 0) return null;

	const ruleCount = elementMatch.matches.length;
	const lines: string[] = [];
	lines.push(`**CSS Rules** (${ruleCount} rule${ruleCount !== 1 ? 's' : ''})`);
	lines.push('');

	for (const m of elementMatch.matches) {
		const spec = `(${m.specificity.join(', ')})`;
		const typeTag = m.matchType !== 'definite' ? ` · *${m.matchType}*` : '';

		let locationLink = '';
		if (stylesheetPath && m.rule.sourceLine > 0) {
			const fileName = path.basename(stylesheetPath);
			const args = encodeURIComponent(JSON.stringify({
				path: stylesheetPath,
				line: m.rule.sourceLine - 1,
				col: m.rule.sourceCol - 1,
			}));
			locationLink = ` · [${fileName}:${m.rule.sourceLine}](command:backflipHTML.openCssRule?${args})`;
		}

		lines.push(`\`${m.selector}\` — ${spec}${typeTag}${locationLink}`);

		if (m.rule.properties.length > 0) {
			const props = m.rule.properties.map(p => `${p.name}: ${p.value}`).join('; ');
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
