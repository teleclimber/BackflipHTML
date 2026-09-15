import type { Hover, Position } from 'vscode-languageserver';
import { MarkupKind } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { ProjectIndex, PartialDef, PartialRef } from './index.js';
import { resolvePartialDef, resolveCallTarget, visibleCustomElementDef } from './index.js';
import { matchingPartialRefs } from './references.js';
import type { CssAnalysisResult, StrippedPseudo } from '@backflip/css';
import type { CompiledFile } from '@backflip/html';
import { resolveAt } from './resolve.js';
import type { DataShape } from '@backflip/html';
import { parseBPartValue, isCustomElementTagName } from '@backflip/html';
import * as path from 'node:path';
import { assetAttrAtCursor, assetRefInValue } from './asset-attr.js';
import { asCallSiteTag, findEnclosingCallSiteTag, findEnclosingOpeningTag } from './tag-context.js';

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
	compiledFile?: CompiledFile | null,
): Hover | null {
	const line = doc.getText({
		start: { line: position.line, character: 0 },
		end: { line: position.line + 1, character: 0 },
	});
	const offset = compiledFile ? doc.offsetAt(position) : undefined;

	return hoverCssSelector(line, position, filePath, cssAnalysis, cssPaths, templateRoot)
		?? hoverAssetRef(line, position, assetDirs)
		?? hoverBPart(line, position, filePath, index)
		?? hoverBName(line, position, filePath, index, templateRoot)
		?? hoverBIn(doc, line, position, filePath, index)
		?? hoverBSlot(doc, line, position, filePath, index)
		?? hoverBData(doc, line, position, filePath, index)
		?? hoverBAttrCallSite(doc, line, position, filePath, index)
		?? hoverCustomElement(line, position, filePath, index, templateRoot)
		?? hoverCssRules(filePath, cssAnalysis, cssPaths, compiledFile, offset)
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

/** How many references a definition hover lists before it stops and counts the rest. */
const MAX_LISTED_REFS = 10;

function formatRefCount(refs: PartialRef[]): string {
	return `${refs.length} reference${refs.length !== 1 ? 's' : ''}`;
}

/**
 * The reference list under a definition hover: one `file:line` per reference,
 * linked to the `b-part` itself.
 *
 * The link needs an absolute path, so without a template root the same list
 * renders as plain text. A reference the compiler gave no location is counted
 * but has nowhere to jump to, so it is not listed — the same rule
 * `findReferences` applies.
 */
function formatRefs(refs: PartialRef[], templateRoot?: string | null): string[] {
	const located = refs.flatMap(ref => (ref.loc ? [{ file: ref.file, loc: ref.loc }] : []));
	const lines = located.slice(0, MAX_LISTED_REFS).map(({ file, loc }) => {
		const label = `${file}:${loc.startLine}`;
		return templateRoot
			? fileLink(label, path.join(templateRoot, file), loc.startLine, loc.startCol)
			: label;
	});
	const hidden = located.length - lines.length;
	if (hidden > 0) lines.push(`*…and ${hidden} more*`);
	return lines;
}

/**
 * A markdown link that opens a file at a position — every clickable location in
 * a hover goes through here.
 *
 * `backflipHTML.openFileAtLocation` is the extension's own command, and it
 * takes 0-based line/column, so the conversion from the compiler's 1-based
 * positions happens here rather than at each call site. A command link is
 * clickable only because the extension's hover middleware marks hover markdown
 * trusted for that one command; it also keeps navigation working in a remote
 * window, where the extension host resolves the path and a bare `file://` URI
 * would point at the wrong machine.
 */
function fileLink(label: string, filePath: string, line: number, col: number): string {
	// encodeURIComponent leaves parentheses alone, and a `)` in a path would end
	// the markdown link early; the command decodes them back either way.
	const args = encodeURIComponent(JSON.stringify({ path: filePath, line: line - 1, col: col - 1 }))
		.replace(/\(/g, '%28')
		.replace(/\)/g, '%29');
	return `[${label}](command:backflipHTML.openFileAtLocation?${args})`;
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

	const attr = assetAttrAtCursor(line, position.character);
	if (!attr) return null;

	const ref = assetRefInValue(attr, position.character);
	if (!ref) {
		// On the attribute, but not on one of its paths.
		return attr.name === 'b-script'
			? mkHover([
				'**`b-script`** — client module for this custom element partial',
				'Auto-included as `<script type="module">` when the partial renders.',
			])
			: mkHover([`**Asset attribute** \`${attr.name}\``]);
	}

	const dirPath = assetDirs.get(ref.name);
	if (!dirPath) {
		return mkHover([`**Asset** \`@${ref.name}\` — *unknown asset directory*`]);
	}
	return mkHover([
		`**Asset** \`@${ref.name}/${ref.subpath}\``,
		`**Directory:** \`${dirPath}\``,
		`**File:** \`${path.join(dirPath, ref.subpath)}\``,
	]);
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
	templateRoot?: string | null,
): Hover | null {
	const value = matchAttr(line, 'b-name', position.character);
	if (value === null) return null;

	const def = resolvePartialDef(value, null, filePath, index);
	if (!def) {
		return mkHover([`**Partial** \`${value}\` — *definition not indexed*`]);
	}

	const refs = matchingPartialRefs(value, def.file, index);
	const lines: string[] = [];
	const exportInfo = def.exported ? 'Exported' : 'Local';
	lines.push(`**Partial** \`${value}\``);
	lines.push(`${exportInfo} · ${formatRefCount(refs)}`);
	lines.push(...formatRefs(refs, templateRoot));
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

	const call = findEnclosingCallSiteTag(doc, position.line, position.character);
	if (!call) {
		return mkHover([`**Slot** \`${slotName}\` — *enclosing partial call not found*`]);
	}

	const { partialName, def } = resolveCallTarget(call, filePath, index);

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
 * Resolve the partial reference made by the opening tag the cursor is in —
 * `<element b-part="...">` or a custom-element tag. Null when that tag makes no
 * call, or names a partial that is not indexed.
 */
function findCallSitePartial(
	doc: TextDocument, position: Position, filePath: string, index: ProjectIndex,
): { partialName: string; def: PartialDef | null } | null {
	const tag = findEnclosingOpeningTag(doc, position.line, position.character);
	if (!tag) return null;
	const call = asCallSiteTag(tag);
	if (!call) return null;
	const target = resolveCallTarget(call, filePath, index);
	// A custom element that resolves to nothing is not a call site to report on:
	// any hyphenated tag looks like one, so an unknown name is more likely plain
	// HTML than a reference.
	if (call.bPartValue === null && !target.def) return null;
	return target;
}

// --- b-attr at call site (plain, :attr, b-bind:attr) ---

function hoverBAttrCallSite(
	doc: TextDocument, line: string, position: Position, filePath: string, index: ProjectIndex,
): Hover | null {
	const attrName = findAttrNameAtCursor(line, position.character);
	if (!attrName) return null;

	const tag = findEnclosingOpeningTag(doc, position.line, position.character);
	if (!tag) return null;
	if (!isCustomElementTagName(tag.tagName)) return null;

	const def = visibleCustomElementDef(tag.tagName, filePath, index);
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
		if (!isCustomElementTagName(tagName)) continue;
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
	templateRoot?: string | null,
): Hover | null {
	const tagInfo = findCustomElementTagAtCursor(line, position.character);
	if (!tagInfo) return null;
	const { tagName, isClosing } = tagInfo;

	const def = visibleCustomElementDef(tagName, filePath, index);
	if (!def) return null;

	const isDefSite = !isClosing
		&& def.file === filePath
		&& def.loc != null
		&& def.loc.startLine === position.line + 1;

	const lines: string[] = [];
	if (isDefSite) {
		const refs = matchingPartialRefs(tagName, def.file, index);
		const exportInfo = def.exported ? 'Exported' : 'Local';
		lines.push(`**Custom element partial** \`<${tagName}>\``);
		lines.push(`${exportInfo} · ${formatRefCount(refs)}`);
		lines.push(...formatRefs(refs, templateRoot));
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
	/** Pseudos the CSS analyzer stripped from this rule's selector before matching. */
	strippedPseudos: StrippedPseudo[];
}

/**
 * "`:hover` (user-action), `::before` (tree-abiding)" — what came off a selector
 * before it was matched, and what kind of thing each one is.
 *
 * The analyzer removes the pseudos a template cannot answer, so a rule reports
 * against the element it targets rather than against nothing. Saying so is what
 * keeps the widening legible: `a:hover` and `a:visited` both list every link.
 */
function formatStrippedPseudos(stripped: StrippedPseudo[]): string {
	return stripped.map(p => `\`${p.text}\` (${p.category})`).join(', ');
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
						strippedPseudos: m.strippedPseudos,
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

	// One note for the whole rule, not one per element: the pseudos came off the
	// selector, so they explain the list rather than any single entry in it.
	const stripped = new Map<string, StrippedPseudo>();
	for (const el of unique) {
		for (const pseudo of el.strippedPseudos) stripped.set(pseudo.text, pseudo);
	}
	if (stripped.size > 0) {
		lines.push('');
		lines.push(`Matched ignoring ${formatStrippedPseudos([...stripped.values()])} — not answerable from a template.`);
	}

	lines.push('');

	for (const el of unique) {
		const typeTag = el.matchType !== 'definite' ? ` · *${el.matchType}*` : '';
		const link = fileLink(`line ${el.startLine}`, path.join(templateRoot, el.file), el.startLine, el.startCol);
		lines.push(`\`${el.file}\` **${el.partialName}** · ${link}${typeTag}`);
	}

	return mkHover(lines);
}

// --- CSS rules hover ---

export interface RuleMatchInfo {
	selector: string;
	specificity: [number, number, number];
	matchType: 'definite' | 'conditional' | 'dynamic';
	/** Pseudos the CSS analyzer stripped from `selector` before matching. */
	strippedPseudos: StrippedPseudo[];
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
 * Find all CSS rules that match the HTML element at the given position.
 * Shared by hover and "Find All Selectors" panel.
 *
 * The element comes from the compiled tree, so the answer is the element the
 * cursor is actually in — the innermost one, told apart from its siblings on
 * the same line and from its own ancestors. `cssAnalysis` only lists elements
 * that matched at least one rule, so an element with no rules resolves to
 * null rather than borrowing a neighbour's.
 */
export function findRulesForElement(
	file: CompiledFile,
	offset: number,
	filePath: string,
	cssAnalysis: CssAnalysisResult,
): ElementRulesResult | null {
	const matches = cssAnalysis.elementMatches.get(filePath);
	if (!matches) return null;

	const target = elementLikeAt(file, offset);
	if (!target) return null;

	// `ElementMatches.startOffset` is the start of the same span, and the CSS
	// layer synthesizes a tag for a custom element definition rather than
	// reusing the tree's node — so match on position, not object identity.
	const elementMatch = matches.find(m => m.startOffset === target.startOffset);
	if (!elementMatch || elementMatch.matches.length === 0) return null;

	return {
		tagName: target.tagName,
		file: elementMatch.file,
		partialName: elementMatch.partialName,
		startLine: elementMatch.startLine,
		startCol: elementMatch.startCol,
		rules: elementMatch.matches.map(m => ({
			selector: m.selector,
			specificity: m.specificity,
			matchType: m.matchType,
			strippedPseudos: m.strippedPseudos,
			properties: m.rule.properties.map(p => ({ name: p.name, value: p.value })),
			mediaConditions: m.mediaConditions,
			sourceLine: m.rule.sourceLine,
			sourceCol: m.rule.sourceCol,
		})),
	};
}

/**
 * The innermost thing at `offset` that renders as a tag, as the tag name it
 * renders and the offset its open tag starts at. A custom element call renders
 * one, and so does a custom element definition, so neither is skipped just
 * because it is not an `element` node.
 */
function elementLikeAt(file: CompiledFile, offset: number): { tagName: string; startOffset: number } | null {
	for (const target of resolveAt(file, offset)) {
		switch (target.kind) {
			case 'element':
				return {
					tagName: target.node.tagName,
					startOffset: (target.node.openTagLoc ?? target.node.loc)!.startOffset,
				};
			case 'custom-element':
				return {
					tagName: target.node.callerTagName ?? target.node.partialName,
					startOffset: target.loc.startOffset,
				};
			case 'custom-element-def':
				return { tagName: target.partialName, startOffset: target.loc.startOffset };
		}
	}
	return null;
}

function hoverCssRules(
	filePath: string,
	cssAnalysis?: CssAnalysisResult | null,
	cssPaths?: string[] | null,
	compiledFile?: CompiledFile | null,
	offset?: number,
): Hover | null {
	if (!cssAnalysis || !compiledFile || offset === undefined) return null;

	const result = findRulesForElement(compiledFile, offset, filePath, cssAnalysis);
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
			const label = `${path.basename(primaryCssPath)}:${m.sourceLine}`;
			locationLink = ` · ${fileLink(label, primaryCssPath, m.sourceLine, m.sourceCol)}`;
		}

		lines.push(`\`${m.selector}\` — ${spec}${typeTag}${locationLink}`);

		// The selector above is as authored, so a rule listed here despite a
		// `:hover` needs to say why it is listed.
		if (m.strippedPseudos.length > 0) {
			lines.push(`  ignoring ${formatStrippedPseudos(m.strippedPseudos)}`);
		}

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

/**
 * Scan upward from `startLine` (exclusive) looking for a regex match. Returns
 * capture group 1. Used for the enclosing `b-name`, where the nearest one above
 * is the answer: a definition is top-level, so none can nest inside another.
 */
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
