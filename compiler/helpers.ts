import { interpretBackcode } from './backcode.js';
import type { Parsed } from './backcode.js';
import { BackflipError } from './errors.js';
import type {
	SourceLoc,
	AssetRef,
	TNode,
	RawTNode,
	PrintTNode,
	ForTNode,
	IfTNode,
	IfBranch,
	SlotTNode,
	PartialRefTNode,
	AttrBindTNode,
	AssetRefTNode,
	AttrPart,
	ParentTNode,
	RootTNode,
	CompiledFile,
} from './types.js';

// --- tag sets ---

export const DOCUMENT_LEVEL_TAGS = new Set(['html', 'head', 'body']);

export const BOOLEAN_ATTRS = new Set([
	'allowfullscreen','async','autofocus','autoplay','checked','controls',
	'default','defer','disabled','formnovalidate','hidden','ismap','loop',
	'multiple','muted','nomodule','novalidate','open','readonly','required',
	'reversed','selected'
]);

// --- parser-state types ---

export type TagMatcher = {
	tag: string,
	tnode?: TNode,
	slotCollection?: {
		partialRef: PartialRefTNode,
		currentSlot: string   // 'default' or named
	}
}

// --- attribute classifiers ---

export function isBindAttr(name: string): boolean {
	return name.startsWith('b-bind:') || name.startsWith(':');
}

export function getBindAttrName(name: string): string {
	if (name.startsWith('b-bind:')) return name.slice('b-bind:'.length);
	if (name.startsWith(':')) return name.slice(1);
	throw new Error(`Not a bind attr: ${name}`);
}

export function isAssetAttr(attrName: string): boolean {
	return attrName.endsWith('~');
}

export function stripAssetSuffix(attrName: string): string {
	return attrName.slice(0, -1);
}

/**
 * Parse a `b-part` attribute value into its file/partialName components.
 *
 * Formats:
 *   "#name"           → same-file reference (file: null)
 *   "file.html#name"  → cross-file reference
 *   "name"            → bare name, same-file reference (file: null)
 */
export function parseBPartValue(value: string): { partialName: string; file: string | null } {
	if (value.startsWith('#')) {
		return { partialName: value.slice(1), file: null };
	}
	const hashIdx = value.indexOf('#');
	if (hashIdx > 0) {
		return { partialName: value.slice(hashIdx + 1), file: value.slice(0, hashIdx) };
	}
	return { partialName: value, file: null };
}

/**
 * True when `name` is a hyphenated tag that should be treated as a custom element
 * partial — i.e. it follows the HTML custom element naming rule (lowercase letter
 * start, contains a hyphen) but is NOT a backflip directive tag (b-*).
 */
export function isCustomElementTagName(name: string): boolean {
	if (!name) return false;
	if (name.startsWith('b-')) return false;
	return /^[a-z][a-z0-9]*-[a-z0-9-]*$/.test(name);
}

/**
 * Given a tag's attrs, return the list of attribute names that will end up on the
 * rendered HTML element (i.e. exclude backflip directives, but resolve b-bind:foo,
 * :foo, and foo~ to their effective HTML attribute name `foo`).
 */
export function effectiveAttrNames(attrs: { name: string, value: string }[]): string[] {
	const names: string[] = [];
	for (const a of attrs) {
		const n = a.name;
		if (n === 'b-name' || n === 'b-export') continue;
		if (n === 'b-if' || n === 'b-for' || n === 'b-else' || n === 'b-else-if') continue;
		if (n === 'b-part' || n === 'b-slot' || n === 'b-in') continue;
		if (n.startsWith('b-data:')) continue;
		if (n.startsWith('b-attr:')) continue;
		if (n.startsWith('b-bind:')) { names.push(n.slice('b-bind:'.length).replace(/~$/, '')); continue; }
		if (n.startsWith(':')) { names.push(n.slice(1).replace(/~$/, '')); continue; }
		if (n.endsWith('~')) { names.push(n.slice(0, -1)); continue; }
		names.push(n);
	}
	return names;
}

// --- source-location helpers (parse5 sourceCodeLocation accessors) ---

type LocAttrs = { attrs?: Record<string, { startLine: number; startCol: number; startOffset: number; endLine: number; endCol: number; endOffset: number }> };

export function attrLoc(tag: { sourceCodeLocation?: unknown }, attrName: string): SourceLoc | undefined {
	const loc = tag.sourceCodeLocation as LocAttrs | null | undefined;
	const a = loc?.attrs?.[attrName];
	if (!a) return undefined;
	return { startLine: a.startLine, startCol: a.startCol, startOffset: a.startOffset,
	         endLine: a.endLine, endCol: a.endCol, endOffset: a.endOffset };
}

export function tagLoc(tag: { sourceCodeLocation?: unknown }): { line?: number, col?: number } {
	const loc = tag.sourceCodeLocation as { startLine?: number; startCol?: number } | null | undefined;
	if (!loc) return {};
	return { line: loc.startLine, col: loc.startCol };
}

export function errorLoc(filename?: string, loc?: { line?: number, col?: number }): { filename?: string, line?: number, col?: number } | undefined {
	if (!filename && !loc?.line) return undefined;
	return { filename, line: loc?.line, col: loc?.col };
}

export function attrErrorLoc(tag: { sourceCodeLocation?: unknown }, attrName: string, filename?: string): { filename?: string, line?: number, col?: number, endLine?: number, endCol?: number } | undefined {
	const a = attrLoc(tag, attrName);
	if (a) return { filename, line: a.startLine, col: a.startCol, endLine: a.endLine, endCol: a.endCol };
	return errorLoc(filename, tagLoc(tag));
}

/**
 * Compute the source location of just the NAME portion of a `b-data:NAME` attribute,
 * starting after the `b-data:` prefix and ending at the close of the name. Returns
 * undefined when no parser-provided location is available.
 */
export function bDataNameLoc(tag: { sourceCodeLocation?: unknown }, attrName: string, bindingName: string): SourceLoc | undefined {
	const a = attrLoc(tag, attrName);
	if (!a) return undefined;
	const prefixLen = 'b-data:'.length;
	return {
		startLine: a.startLine,
		startCol: a.startCol + prefixLen,
		startOffset: a.startOffset + prefixLen,
		endLine: a.startLine,
		endCol: a.startCol + prefixLen + bindingName.length,
		endOffset: a.startOffset + prefixLen + bindingName.length,
	};
}

export function interpolationLoc(
	textLoc: { startLine: number; startCol: number; startOffset: number },
	rawBefore: string,
	matchStr: string
): SourceLoc {
	const startOffset = textLoc.startOffset + rawBefore.length;
	const endOffset = startOffset + matchStr.length;
	const newlinesBefore = (rawBefore.match(/\n/g) ?? []).length;
	const lastNl = rawBefore.lastIndexOf('\n');
	const startLine = textLoc.startLine + newlinesBefore;
	const startCol = lastNl === -1 ? textLoc.startCol + rawBefore.length : rawBefore.length - lastNl;
	const endLine = startLine;
	const endCol = startCol + matchStr.length;
	return { startLine, startCol, startOffset, endLine, endCol, endOffset };
}

export class LineMap {
	private lineStarts: number[] = [0];
	constructor(html: string) {
		for (let i = 0; i < html.length; i++) {
			if (html[i] === '\n') this.lineStarts.push(i + 1);
		}
	}
	getLoc(offset: number): { line: number, col: number } {
		let l = 0, r = this.lineStarts.length - 1;
		while (l <= r) {
			const m = Math.floor((l + r) / 2);
			if (this.lineStarts[m] <= offset) l = m + 1;
			else r = m - 1;
		}
		return { line: r + 1, col: offset - this.lineStarts[r] + 1 };
	}
}

// --- asset helpers ---

export function parseAssetRef(value: string): AssetRef | null {
	if (!value.startsWith('@')) return null;
	const slashIdx = value.indexOf('/');
	if (slashIdx === -1) return null;
	return {
		name: value.slice(1, slashIdx),
		subpath: value.slice(slashIdx + 1),
	};
}

export function validateAssetRef(
	ref: AssetRef,
	assetMap: Map<string, string> | undefined,
	assetDirs: Map<string, string> | undefined,
	loc: { filename?: string; line?: number; col?: number } | undefined,
): BackflipError | null {
	if (assetMap && !assetMap.has(ref.name)) {
		return new BackflipError(`unknown asset directory "@${ref.name}"`, { ...(loc || {}), severity: 'error' });
	}
	if (ref.subpath.split('/').some(seg => seg === '..')) {
		return new BackflipError(`path traversal is not allowed in asset path`, { ...(loc || {}), severity: 'error' });
	}
	return null;
}

export function replaceAssetRef(value: string, assetMap: Map<string, string>): string {
	for (const [name, prefix] of assetMap) {
		value = value.replaceAll(`@${name}/`, prefix);
	}
	return value;
}

export function parseSrcsetEntriesWithOffsets(value: string): { url: string, offset: number }[] {
	const entries: { url: string, offset: number }[] = [];
	let lastIndex = 0;
	while (lastIndex < value.length) {
		const commaIdx = value.indexOf(',', lastIndex);
		const endIdx = commaIdx === -1 ? value.length : commaIdx;
		const part = value.substring(lastIndex, endIdx);

		const match = part.match(/^\s*([^\s]+)/);
		if (match) {
			entries.push({ url: match[1], offset: lastIndex + match.index! + (match[0].length - match[1].length) });
		}

		if (commaIdx === -1) break;
		lastIndex = commaIdx + 1;
	}
	return entries;
}

export interface AssetAttrCtx {
	html: string;
	lineMap: LineMap;
	assetMap?: Map<string, string>;
	assetDirs?: Map<string, string>;
	filename?: string;
}

/**
 * Validate a static asset attribute value, returning the parsed refs (no replacement).
 * The returned `error` is non-null when the attribute is malformed or the asset directory
 * is unknown; otherwise `refs` carries one entry per URL (1 for src~, N for srcset~).
 */
export function validateStaticAssetAttr(
	attrName: string,
	value: string,
	tag: { sourceCodeLocation?: unknown },
	origAttrName: string,
	ctx: AssetAttrCtx,
): { refs: AssetRef[], originalValue: string, error?: BackflipError } {
	const { html, lineMap, assetMap, assetDirs, filename } = ctx;
	if (!assetMap) {
		return { refs: [], originalValue: value, error: new BackflipError(`${attrName}~ used but no asset directories are configured`, attrErrorLoc(tag, origAttrName, filename)) };
	}
	if (attrName === 'style') {
		return { refs: [], originalValue: value, error: new BackflipError(`style~ is not supported`, attrErrorLoc(tag, origAttrName, filename)) };
	}

	const attrLocation = attrLoc(tag, origAttrName);
	let valueStartOffset = 0;
	if (attrLocation) {
		const attrText = html.substring(attrLocation.startOffset, attrLocation.endOffset);
		const relativeValueOffset = attrText.indexOf(value);
		if (relativeValueOffset !== -1) {
			valueStartOffset = attrLocation.startOffset + relativeValueOffset;
		} else {
			valueStartOffset = attrLocation.startOffset; // fallback
		}
	}

	function createAssetRef(val: string, localOffset: number): AssetRef | null {
		if (!val.startsWith('@')) return null;
		const slashIdx = val.indexOf('/');
		if (slashIdx === -1) return null;

		const name = val.slice(1, slashIdx);
		const subpath = val.slice(slashIdx + 1);

		const ref: AssetRef = { name, subpath };

		if (attrLocation && valueStartOffset > 0) {
			const absStart = valueStartOffset + localOffset;
			const absEnd = absStart + val.length;
			const startLoc = lineMap.getLoc(absStart);
			const endLoc = lineMap.getLoc(absEnd);
			ref.loc = {
				startLine: startLoc.line, startCol: startLoc.col, startOffset: absStart,
				endLine: endLoc.line, endCol: endLoc.col, endOffset: absEnd
			};

			const subpathAbsStart = absStart + slashIdx + 1;
			const subpathStartLoc = lineMap.getLoc(subpathAbsStart);
			ref.subpathLoc = {
				startLine: subpathStartLoc.line, startCol: subpathStartLoc.col, startOffset: subpathAbsStart,
				endLine: endLoc.line, endCol: endLoc.col, endOffset: absEnd
			};
		}
		return ref;
	}

	function getErrLoc(refLoc: SourceLoc | undefined): { filename?: string, line?: number, col?: number, endLine?: number, endCol?: number } | undefined {
		if (refLoc) {
			return { filename, line: refLoc.startLine, col: refLoc.startCol, endLine: refLoc.endLine, endCol: refLoc.endCol };
		}
		return attrErrorLoc(tag, origAttrName, filename);
	}

	if (attrName === 'srcset') {
		const entries = parseSrcsetEntriesWithOffsets(value);
		const refs: AssetRef[] = [];
		for (const { url, offset } of entries) {
			const ref = createAssetRef(url, offset);
			if (!ref) {
				return { refs: [], originalValue: value, error: new BackflipError(`asset path must start with @name: "${url}"`, attrErrorLoc(tag, origAttrName, filename)) };
			}
			const errLoc = getErrLoc(ref.loc);
			const err = validateAssetRef(ref, assetMap, assetDirs, errLoc);
			if (err) return { refs: [], originalValue: value, error: err };
			refs.push(ref);
		}
		return { refs, originalValue: value };
	}

	// Single URL attribute
	const ref = createAssetRef(value, 0);
	if (!ref) {
		return { refs: [], originalValue: value, error: new BackflipError(`asset path must start with @name`, attrErrorLoc(tag, origAttrName, filename)) };
	}
	const errLoc = getErrLoc(ref.loc);
	const err = validateAssetRef(ref, assetMap, assetDirs, errLoc);
	if (err) return { refs: [], originalValue: value, error: err };
	return { refs: [ref], originalValue: value };
}

// --- tag reconstruction ---

// Helper: build tag prefix (no closing >) excluding certain attrs, b-data:*, b-attr:*, bind attrs, and asset~ attrs
export function buildTagPrefix(tag: {tagName:string, attrs:{name:string,value:string}[], sourceCodeLocation?: unknown}, excludeAttrs: string[]): string {
	let tag_str = `<${tag.tagName}`;
	const processed: string[] = [];
	for (const attr of tag.attrs) {
		if (excludeAttrs.includes(attr.name) || attr.name.startsWith('b-data:') || attr.name.startsWith('b-attr:') || isBindAttr(attr.name) || isAssetAttr(attr.name)) continue;
		processed.push(`${attr.name}="${attr.value}"`);
	}
	if (processed.length > 0) tag_str += ' ' + processed.join(' ');
	return tag_str;
}

/**
 * Build the `data-loc="file#partial:line:col"` attribute appended to raw HTML when
 * source-location tracking is on. Returns '' when locations are disabled, when no
 * partial is currently being compiled, or when the parser didn't provide a location.
 */
export function dataLocAttr(
	tag: { sourceCodeLocation?: unknown },
	ctx: { includeLocs: boolean; currentPartialName: string | null; filename?: string },
): string {
	if (!ctx.includeLocs || !ctx.currentPartialName) return '';
	const loc = tag.sourceCodeLocation as { startLine?: number; startCol?: number } | null | undefined;
	if (!loc?.startLine) return '';
	const file = ctx.filename ?? '';
	return ` data-loc="${file}#${ctx.currentPartialName}:${loc.startLine}:${loc.startCol}"`;
}

// --- open-tag attr classification & assembly ---

/**
 * Normalized stream produced by classifyOpenTagAttrs. The same segment list
 * feeds both full-open-tag and attrs-only emitters, so we never build the
 * brackets up just to slice them off later.
 */
export type AttrSegment =
	| { kind: 'static', text: string }
	| { kind: 'asset', attrName: string, originalValue: string, refs: AssetRef[], loc: SourceLoc | undefined }
	| { kind: 'bind', name: string, expr: Parsed, isBoolean: boolean, isAsset: boolean, loc: SourceLoc | undefined };

/**
 * Walk a tag's attrs once, filtering b-name/b-export/etc. (`excludeAttrs`),
 * b-data:*, and b-attr:*, validating any static asset attrs, and emitting a
 * normalized AttrSegment stream. `hasBind` tells the caller whether the
 * output should be a Raw + AssetRef sequence (no binds) or a single
 * AttrBindTNode (binds present). Validation errors are returned as data
 * rather than thrown or mutated into a shared array.
 */
export function classifyOpenTagAttrs(
	tag: { attrs: { name: string, value: string }[], sourceCodeLocation?: unknown },
	excludeAttrs: string[],
	ctx: AssetAttrCtx,
): { segments: AttrSegment[], hasBind: boolean, errors: BackflipError[] } {
	const segments: AttrSegment[] = [];
	const errors: BackflipError[] = [];
	let hasBind = false;
	for (const attr of tag.attrs) {
		if (excludeAttrs.includes(attr.name) || attr.name.startsWith('b-data:') || attr.name.startsWith('b-attr:')) continue;
		if (isBindAttr(attr.name)) {
			let bindName = getBindAttrName(attr.name);
			let isAsset = false;
			if (isAssetAttr(bindName)) {
				bindName = stripAssetSuffix(bindName);
				if (!ctx.assetMap) {
					errors.push(new BackflipError(`${bindName}~ used but no asset directories are configured`, attrErrorLoc(tag, attr.name, ctx.filename)));
					continue;
				}
				if (bindName === 'style') {
					errors.push(new BackflipError(`style~ is not supported`, attrErrorLoc(tag, attr.name, ctx.filename)));
					continue;
				}
				isAsset = true;
			}
			hasBind = true;
			segments.push({
				kind: 'bind',
				name: bindName,
				expr: interpretBackcode(attr.value),
				isBoolean: BOOLEAN_ATTRS.has(bindName),
				isAsset,
				loc: attrLoc(tag, attr.name),
			});
		} else if (isAssetAttr(attr.name)) {
			const realName = stripAssetSuffix(attr.name);
			const { refs, originalValue, error } = validateStaticAssetAttr(realName, attr.value, tag, attr.name, ctx);
			if (error) { errors.push(error); continue; }
			segments.push({
				kind: 'asset',
				attrName: realName,
				originalValue,
				refs,
				loc: attrLoc(tag, attr.name),
			});
		} else {
			segments.push({ kind: 'static', text: ` ${attr.name}="${attr.value}"` });
		}
	}
	return { segments, hasBind, errors };
}

/**
 * Assemble a Raw + AssetRefTNode interleaved sequence. Used when there are
 * no bind attrs. `prefix` is prepended to the first raw chunk and `suffix`
 * appended to the final one (callers pass `<tagName` / `>` for full open
 * tags, and empty strings for attrs-only).
 */
export function buildRawAttrSequence(segments: AttrSegment[], prefix: string, suffix: string, parent: ParentTNode): TNode[] {
	const nodes: TNode[] = [];
	let buf = prefix;
	for (const seg of segments) {
		if (seg.kind === 'static') {
			buf += seg.text;
		} else if (seg.kind === 'asset') {
			if (buf) { nodes.push({ type: 'raw', raw: buf, parent } as RawTNode); buf = ''; }
			nodes.push({ type: 'asset-ref', attrName: seg.attrName, originalValue: seg.originalValue, refs: seg.refs, parent, loc: seg.loc } as AssetRefTNode);
		}
		// 'bind' segments don't appear when hasBind is false
	}
	buf += suffix;
	if (buf) nodes.push({ type: 'raw', raw: buf, parent } as RawTNode);
	if (nodes.length === 0) nodes.push({ type: 'raw', raw: '', parent } as RawTNode);
	return nodes;
}

/**
 * Assemble a single AttrBindTNode from a segment stream that includes at
 * least one bind. `trailingStatic` (typically the data-loc attr) is appended
 * into the final static AttrPart. `attrsOnly` sets the flag so the renderer
 * suppresses `tagOpen` and the trailing `>`.
 */
export function buildAttrBindNode(
	segments: AttrSegment[],
	tagOpen: string,
	trailingStatic: string,
	selfClosing: boolean,
	attrsOnly: boolean,
	parent: ParentTNode,
): AttrBindTNode {
	const parts: AttrPart[] = [];
	let staticBuf = '';
	for (const seg of segments) {
		if (seg.kind === 'static') {
			staticBuf += seg.text;
		} else {
			if (staticBuf) { parts.push({ type: 'static', raw: staticBuf }); staticBuf = ''; }
			if (seg.kind === 'asset') {
				parts.push({ type: 'asset', attrName: seg.attrName, originalValue: seg.originalValue, refs: seg.refs, loc: seg.loc });
			} else {
				const part: AttrPart = { type: 'dynamic', name: seg.name, expr: seg.expr, isBoolean: seg.isBoolean, loc: seg.loc };
				if (seg.isAsset) part.isAsset = true;
				parts.push(part);
			}
		}
	}
	staticBuf += trailingStatic;
	if (staticBuf) parts.push({ type: 'static', raw: staticBuf });
	const node: AttrBindTNode = { type: 'attr-bind', tagOpen, parts, parent };
	if (selfClosing) node.selfClosing = true;
	if (attrsOnly) node.attrsOnly = true;
	return node;
}

// --- if-branch lookup ---

// This should be renamed to InPartial?
export function findPrecedingIfInFile(cur: TNode, loc?: { filename?: string, line?: number, col?: number }): IfTNode {
	if (cur.type === 'if') return cur;
	if (cur.parent && 'tnodes' in cur.parent) {
		const siblings = cur.parent.tnodes;
		for (let i = siblings.length - 1; i >= 0; i--) {
			if (siblings[i].type === 'if') return siblings[i] as IfTNode;
			if (siblings[i].type === 'raw' && (siblings[i] as RawTNode).raw.trim() === '') continue;
			break;
		}
	}
	throw new BackflipError("b-else-if/b-else must follow a b-if block", loc);
}

export function findPrecedingIfInSlot(arr: TNode[], loc?: { filename?: string, line?: number, col?: number }): IfTNode {
	for (let i = arr.length - 1; i >= 0; i--) {
		if (arr[i].type === 'if') return arr[i] as IfTNode;
		if (arr[i].type === 'raw' && (arr[i] as RawTNode).raw.trim() === '') continue;
		break;
	}
	throw new BackflipError("b-else-if/b-else must follow a b-if block", loc);
}

// --- text / raw node helpers ---

const text_regex = new RegExp("({{[^{}]*}})", 'g');

export function onText(cur:TNode, raw :string, textLoc?: {startLine:number;startCol:number;startOffset:number}) :TNode {
	// later match string against {{ }}
	const matches = raw.matchAll(text_regex);

	let raw_it = 0;
	for( const m of matches ) {
		if( m.index > raw_it ) {
			cur = pushRaw(cur, raw.substring(raw_it, m.index));
		}
		const code_str = m[0].substring(2, m[0].length -2).trim();
		if( !code_str ) {
			// empty {{ }}, treat as raw text
			cur = pushRaw(cur, m[0]);
			raw_it = m.index + m[0].length;
			continue;
		}
		const code_parsed = interpretBackcode(code_str);

		const print_node :PrintTNode = {
			type: 'print',
			data: code_parsed,
			parent: cur.parent
		};
		if (textLoc) print_node.loc = interpolationLoc(textLoc, raw.substring(0, m.index), m[0]);
		if( !cur.parent?.tnodes ) throw new BackflipError("expected tnodes here");
		cur.parent.tnodes.push(print_node);
		cur = print_node;

		raw_it = m.index + m[0].length;
	}

	if( raw_it < raw.length ) {
		cur = pushRaw(cur, raw.substring(raw_it, raw.length));
	}

	return cur;
}

export function pushRaw(cur_tnode: TNode, raw :string) :TNode {
	if( cur_tnode.type === 'raw' ) {
		cur_tnode.raw += raw
	}
	else {
		const raw_node :TNode = {
			type: 'raw',
			raw: raw,
			parent: cur_tnode.parent
		};
		if( !cur_tnode.parent?.tnodes ) throw new BackflipError("expected tnodes here");
		cur_tnode.parent.tnodes.push(raw_node);
		cur_tnode = raw_node;
	}
	return cur_tnode;
}

// --- slot collection ---

/**
 * Walk the open-tag stack and return the innermost slot-collection context.
 * Stops at any entry with a structural `tnode` first — content inside b-for/b-if
 * should flow into that node's tree, not into the slot above it.
 */
export function getSlotCollection(tag_stack: TagMatcher[]): { partialRef: PartialRefTNode, currentSlot: string } | null {
	for (let i = tag_stack.length - 1; i >= 0; i--) {
		if (tag_stack[i].slotCollection) {
			return tag_stack[i].slotCollection!;
		}
		if (tag_stack[i].tnode) {
			return null;
		}
	}
	return null;
}

/**
 * Collect slot names declared (via b-slot) in a list of tnodes.
 */
export function collectSlots(tnodes: TNode[]): string[] {
	const slots: string[] = [];
	walkForSlots(tnodes, slots);
	return slots;
}

function walkForSlots(tnodes: TNode[], slots: string[]): void {
	for (const tnode of tnodes) {
		if (tnode.type === 'slot') {
			slots.push((tnode as SlotTNode).name ?? 'default');
		} else if (tnode.type === 'for') {
			walkForSlots((tnode as ForTNode).tnodes, slots);
		} else if (tnode.type === 'if') {
			for (const branch of (tnode as IfTNode).branches) {
				walkForSlots(branch.tnodes, slots);
			}
		}
	}
}

// --- asset resolution (stage 2) ---

/**
 * Stage 2: Resolve AssetRefTNode nodes in a compiled AST using an asset map.
 * Returns a new CompiledFile with AssetRefTNodes replaced by RawTNodes
 * and 'asset' AttrParts replaced by 'static' AttrParts.
 * The input CompiledFile is not mutated.
 */
export function resolveAssetRefs(compiled: CompiledFile, assetMap: Map<string, string>): CompiledFile {
	const newPartials = new Map<string, RootTNode>();
	for (const [name, root] of compiled.partials) {
		const newRoot: RootTNode = {
			type: 'root',
			tnodes: [],
			...(root.loc ? { loc: root.loc } : {}),
			...(root.exported !== undefined ? { exported: root.exported } : {}),
			...(root.customElement !== undefined ? { customElement: root.customElement } : {}),
			...(root.definitionAttrNames ? { definitionAttrNames: root.definitionAttrNames } : {}),
			...(root.bAttrs ? { bAttrs: root.bAttrs } : {}),
			...(root.meta ? { meta: root.meta } : {}),
		};
		newRoot.tnodes = resolveTNodes(root.tnodes, newRoot, assetMap);
		if (root.definitionAttrNodes) {
			newRoot.definitionAttrNodes = resolveTNodes(root.definitionAttrNodes, newRoot, assetMap);
		}
		newPartials.set(name, newRoot);
	}
	return { partials: newPartials };
}

function resolveTNodes(tnodes: TNode[], parent: ParentTNode, assetMap: Map<string, string>): TNode[] {
	const result: TNode[] = [];
	for (const node of tnodes) {
		switch (node.type) {
			case 'asset-ref': {
				const n = node as AssetRefTNode;
				const resolved = replaceAssetRef(n.originalValue, assetMap);
				const raw = ` ${n.attrName}="${resolved}"`;
				// Merge into preceding RawTNode if possible
				const prev = result[result.length - 1];
				if (prev && prev.type === 'raw') {
					(prev as RawTNode).raw += raw;
				} else {
					result.push({ type: 'raw', raw, parent } as RawTNode);
				}
				break;
			}
			case 'raw': {
				const n = node as RawTNode;
				// Merge into preceding RawTNode if possible
				const prev = result[result.length - 1];
				if (prev && prev.type === 'raw') {
					(prev as RawTNode).raw += n.raw;
				} else {
					result.push({ type: 'raw', raw: n.raw, parent } as RawTNode);
				}
				break;
			}
			case 'print': {
				const n = node as PrintTNode;
				const newNode: PrintTNode = { type: 'print', data: n.data, parent };
				if (n.loc) newNode.loc = n.loc;
				result.push(newNode);
				break;
			}
			case 'slot': {
				const n = node as SlotTNode;
				const newNode: SlotTNode = { type: 'slot', name: n.name, parent };
				if (n.loc) newNode.loc = n.loc;
				result.push(newNode);
				break;
			}
			case 'for': {
				const n = node as ForTNode;
				const newNode: ForTNode = { type: 'for', iterable: n.iterable, valName: n.valName, tnodes: [], parent };
				if (n.loc) newNode.loc = n.loc;
				newNode.tnodes = resolveTNodes(n.tnodes, newNode, assetMap);
				result.push(newNode);
				break;
			}
			case 'if': {
				const n = node as IfTNode;
				const newNode: IfTNode = { type: 'if', branches: [], parent };
				for (const branch of n.branches) {
					const newBranch: IfBranch = { condition: branch.condition, tnodes: [], ifNode: newNode };
					if (branch.loc) newBranch.loc = branch.loc;
					newBranch.tnodes = resolveTNodes(branch.tnodes, newBranch, assetMap);
					newNode.branches.push(newBranch);
				}
				result.push(newNode);
				break;
			}
			case 'partial-ref': {
				const n = node as PartialRefTNode;
				const newSlots: { [slotName: string]: TNode[] } = {};
				for (const [slotName, slotTnodes] of Object.entries(n.slots)) {
					// Slot tnodes have the partial-ref's parent as their parent
					newSlots[slotName] = resolveTNodes(slotTnodes, parent, assetMap);
				}
				const newNode: PartialRefTNode = {
					type: 'partial-ref',
					file: n.file,
					partialName: n.partialName,
					wrapper: n.wrapper,
					slots: newSlots,
					bindings: n.bindings,
					parent,
				};
				if (n.slotLocs) newNode.slotLocs = n.slotLocs;
				if (n.loc) newNode.loc = n.loc;
				if (n.customElement) newNode.customElement = true;
				if (n.callerTagName) newNode.callerTagName = n.callerTagName;
				if (n.callerAttrNames) newNode.callerAttrNames = n.callerAttrNames;
				if (n.callerAttrInfos) newNode.callerAttrInfos = n.callerAttrInfos;
				if (n.unresolvedRaw) newNode.unresolvedRaw = n.unresolvedRaw;
				if (n.callerOpenTag) newNode.callerOpenTag = resolveTNodes(n.callerOpenTag, parent, assetMap);
				result.push(newNode);
				break;
			}
			case 'attr-bind': {
				const n = node as AttrBindTNode;
				const newParts: AttrPart[] = resolveAttrParts(n.parts, assetMap);
				const newNode: AttrBindTNode = { type: 'attr-bind', tagOpen: n.tagOpen, parts: newParts, parent };
				if (n.selfClosing) newNode.selfClosing = true;
				if (n.attrsOnly) newNode.attrsOnly = true;
				result.push(newNode);
				break;
			}
		}
	}
	return result;
}

function resolveAttrParts(parts: AttrPart[], assetMap: Map<string, string>): AttrPart[] {
	const result: AttrPart[] = [];
	for (const part of parts) {
		if (part.type === 'asset') {
			const resolved = replaceAssetRef(part.originalValue, assetMap);
			const raw = ` ${part.attrName}="${resolved}"`;
			// Merge into preceding static part if possible
			const prev = result[result.length - 1];
			if (prev && prev.type === 'static') {
				prev.raw += raw;
			} else {
				result.push({ type: 'static', raw });
			}
		} else if (part.type === 'static') {
			// Merge into preceding static part if possible
			const prev = result[result.length - 1];
			if (prev && prev.type === 'static') {
				prev.raw += part.raw;
			} else {
				result.push({ type: 'static', raw: part.raw });
			}
		} else {
			// dynamic parts pass through unchanged
			result.push({ ...part });
		}
	}
	return result;
}
