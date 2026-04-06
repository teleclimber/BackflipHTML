import {RewritingStream} from 'parse5-html-rewriting-stream';
import stream from 'node:stream';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { interpretBackcode } from './backcode.js';
import type { Parsed } from './backcode.js';
export { BackflipError } from './errors.js';
import { BackflipError } from './errors.js';
import { inferFreeVars, inferDataShape } from './data-shape.js';
import type { DataShape } from './data-shape.js';

export interface SourceLoc {
	startLine: number;    // 1-based
	startCol: number;     // 1-based
	startOffset: number;  // 0-based char index into the source file
	endLine: number;
	endCol: number;
	endOffset: number;    // points directly after the last character
}

export interface PartialMeta {
	startOffset: number;   // 0-based, start of opening tag '<'
	endOffset: number;     // 0-based, just past closing tag '>'
	startLine: number;     // 1-based
	startCol: number;      // 1-based
	isDocumentLevel: boolean;  // true if partial contains/is html, head, or body
}

export interface ChildTNode {
	parent: ParentTNode
}
export interface RootTNode {
	type: 'root',
	tnodes: TNode[],
	loc?: SourceLoc,
	exported?: boolean,
	freeVars?: string[],
	dataShape?: Map<string, DataShape>,
	meta?: PartialMeta
}
export interface RawTNode extends ChildTNode {
	type: 'raw',
	raw: string
}
export interface PrintTNode extends ChildTNode {	// for outputing {{ foo }} into HTML (do escaping)
	type: 'print',
	data: Parsed,
	loc?: SourceLoc
}
export interface ForTNode extends ChildTNode {
	type: 'for',
	iterable: Parsed,
	valName: string,
	tnodes: TNode[],
	loc?: SourceLoc
}
export interface IfBranch {
	condition?: Parsed,
	tnodes: TNode[],
	ifNode: IfTNode,
	loc?: SourceLoc
}
export interface IfTNode extends ChildTNode {
	type: 'if',
	branches: IfBranch[]
}

export interface SlotTNode extends ChildTNode {
	type: 'slot',
	name: string | undefined,   // undefined = default slot
	loc?: SourceLoc
}
export interface PartialBinding {
	name: string,
	data: Parsed
}
export interface PartialRefTNode extends ChildTNode {
	type: 'partial-ref',
	file: string | null,        // null = same-file reference (b-part="#name")
	partialName: string,
	wrapper: { open: string, close: string } | null,  // null if <b-unwrap b-part>
	slots: { [slotName: string]: TNode[] },            // 'default' for unnamed
	slotLocs?: { [slotName: string]: SourceLoc },       // source locations for b-in attributes
	bindings: PartialBinding[],
	loc?: SourceLoc
}

export interface CompiledFile {
	partials: Map<string, RootTNode>  // partialName → compiled tree
}

export type PartialRegistry = Map<string, Set<string>>
// key: relative file path e.g. "graphics/charts.html"
// value: set of exported partial names in that file

export type AttrPart =
	| { type: 'static'; raw: string }
	| { type: 'dynamic'; name: string; expr: Parsed; isBoolean: boolean; isAsset?: boolean; loc?: SourceLoc }
	| { type: 'asset'; attrName: string; originalValue: string; refs: AssetRef[]; loc?: SourceLoc }

export interface AttrBindTNode extends ChildTNode {
	type: 'attr-bind'
	tagOpen: string   // e.g. `<a`
	parts: AttrPart[]
	selfClosing?: boolean
}

export interface AssetRefTNode extends ChildTNode {
	type: 'asset-ref'
	attrName: string          // e.g. "src", "srcset"
	originalValue: string     // e.g. "@images/photo.jpg"
	refs: AssetRef[]          // parsed refs (1 for src~, N for srcset~)
	loc?: SourceLoc
}

export type TNode = RawTNode | PrintTNode | ForTNode | IfTNode | SlotTNode | PartialRefTNode | AttrBindTNode | AssetRefTNode;
export type ParentTNode = RootTNode | ForTNode | IfBranch;

type TagMatcher = {
	tag: string,
	tnode?: TNode,
	slotCollection?: {
		partialRef: PartialRefTNode,
		currentSlot: string   // 'default' or named
	}
}

const DOCUMENT_LEVEL_TAGS = new Set(['html', 'head', 'body']);

const BOOLEAN_ATTRS = new Set([
	'allowfullscreen','async','autofocus','autoplay','checked','controls',
	'default','defer','disabled','formnovalidate','hidden','ismap','loop',
	'multiple','muted','nomodule','novalidate','open','readonly','required',
	'reversed','selected'
]);

function isBindAttr(name: string): boolean {
	return name.startsWith('b-bind:') || name.startsWith(':');
}

function getBindAttrName(name: string): string {
	if (name.startsWith('b-bind:')) return name.slice('b-bind:'.length);
	if (name.startsWith(':')) return name.slice(1);
	throw new Error(`Not a bind attr: ${name}`);
}

type LocAttrs = { attrs?: Record<string, { startLine: number; startCol: number; startOffset: number; endLine: number; endCol: number; endOffset: number }> };

function attrLoc(tag: { sourceCodeLocation?: unknown }, attrName: string): SourceLoc | undefined {
	const loc = tag.sourceCodeLocation as LocAttrs | null | undefined;
	const a = loc?.attrs?.[attrName];
	if (!a) return undefined;
	return { startLine: a.startLine, startCol: a.startCol, startOffset: a.startOffset,
	         endLine: a.endLine, endCol: a.endCol, endOffset: a.endOffset };
}

function tagLoc(tag: { sourceCodeLocation?: unknown }): { line?: number, col?: number } {
	const loc = tag.sourceCodeLocation as { startLine?: number; startCol?: number } | null | undefined;
	if (!loc) return {};
	return { line: loc.startLine, col: loc.startCol };
}

function errorLoc(filename?: string, loc?: { line?: number, col?: number }): { filename?: string, line?: number, col?: number } | undefined {
	if (!filename && !loc?.line) return undefined;
	return { filename, line: loc?.line, col: loc?.col };
}

function attrErrorLoc(tag: { sourceCodeLocation?: unknown }, attrName: string, filename?: string): { filename?: string, line?: number, col?: number, endLine?: number, endCol?: number } | undefined {
	const a = attrLoc(tag, attrName);
	if (a) return { filename, line: a.startLine, col: a.startCol, endLine: a.endLine, endCol: a.endCol };
	return errorLoc(filename, tagLoc(tag));
}

function interpolationLoc(
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


// --- Asset attribute helpers ---

function isAssetAttr(attrName: string): boolean {
	return attrName.endsWith('~');
}

function stripAssetSuffix(attrName: string): string {
	return attrName.slice(0, -1);
}

export interface AssetRef {
	name: string;    // the @name part
	subpath: string; // everything after @name/
}

function parseAssetRef(value: string): AssetRef | null {
	if (!value.startsWith('@')) return null;
	const slashIdx = value.indexOf('/');
	if (slashIdx === -1) return null;
	return {
		name: value.slice(1, slashIdx),
		subpath: value.slice(slashIdx + 1),
	};
}

function validateAssetRef(
	ref: AssetRef,
	assetMap: Map<string, string> | undefined,
	assetDirs: Map<string, string> | undefined,
	loc: { filename?: string; line?: number; col?: number } | undefined,
): BackflipError | null {
	if (assetMap && !assetMap.has(ref.name)) {
		return new BackflipError(`unknown asset directory "@${ref.name}"`, loc);
	}
	if (ref.subpath.split('/').some(seg => seg === '..')) {
		return new BackflipError(`path traversal is not allowed in asset path`, loc);
	}
	if (assetDirs) {
		const dir = assetDirs.get(ref.name);
		if (dir) {
			const filePath = path.join(dir, ref.subpath);
			try {
				fs.statSync(filePath);
			} catch {
				return new BackflipError(`asset file not found: @${ref.name}/${ref.subpath}`, loc);
			}
		}
	}
	return null;
}

function replaceAssetRef(value: string, assetMap: Map<string, string>): string {
	for (const [name, prefix] of assetMap) {
		value = value.replaceAll(`@${name}/`, prefix);
	}
	return value;
}

function parseSrcsetEntries(value: string): string[] {
	return value.split(',').map(entry => entry.trim().split(/\s+/)[0]).filter(url => url.length > 0);
}

export interface CompileOptions {
	includeLocs?: boolean;
	assetMap?: Map<string, string>;    // @name -> replacement prefix
	assetDirs?: Map<string, string>;   // @name -> absolute dir path (for file existence checks)
}

export function compileFile(html: string, _registry?: PartialRegistry, filename?: string, options?: CompileOptions): Promise<{ compiled: CompiledFile, errors: BackflipError[] }> {

	return new Promise((resolve, reject) => {

		const errors: BackflipError[] = [];

		const s = new stream.Readable({encoding: 'utf8'});
		s.push(html);
		s.push(null);

		const tag_stack: TagMatcher[] = [];

		const compiledFile: CompiledFile = { partials: new Map() };

		// current partial being compiled (null = top-level, outside any b-name partial)
		let currentPartialRoot: RootTNode | null = null;
		let currentPartialName: string | null = null;
		let cur_tnode: TNode | null = null;

		const includeLocs = options?.includeLocs ?? false;

		// Helper: build data-loc attribute for source location tracking
		function dataLocAttr(tag: { sourceCodeLocation?: unknown }): string {
			if (!includeLocs || !currentPartialName) return '';
			const loc = tag.sourceCodeLocation as { startLine?: number; startCol?: number } | null | undefined;
			if (!loc?.startLine) return '';
			const file = filename ?? '';
			return ` data-loc="${file}#${currentPartialName}:${loc.startLine}:${loc.startCol}"`;
		}

		// Helper: get current slot-collection context from innermost tag_stack entry.
		// Walks up the stack, stopping if a structural node (tnode) is found first —
		// content inside b-for/b-if should flow into that node's tree, not the slot.
		function getSlotCollection(): { partialRef: PartialRefTNode, currentSlot: string } | null {
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

		// Helper: push a raw string into the right place (slot or normal)
		function pushRawHere(raw: string): TNode | null {
			const sc = getSlotCollection();
			if (sc) {
				const slotName = sc.currentSlot;
				if (!sc.partialRef.slots[slotName]) {
					sc.partialRef.slots[slotName] = [];
				}
				const arr = sc.partialRef.slots[slotName];
				const lastNode = arr.length > 0 ? arr[arr.length - 1] : null;
				if (lastNode && lastNode.type === 'raw') {
					(lastNode as RawTNode).raw += raw;
					return lastNode;
				} else {
					const raw_node: RawTNode = { type: 'raw', raw, parent: sc.partialRef.parent };
					arr.push(raw_node);
					return raw_node;
				}
			} else {
				if (cur_tnode === null) {
					if (currentPartialRoot === null) return null;
					const raw_node: RawTNode = { type: 'raw', raw, parent: currentPartialRoot };
					currentPartialRoot.tnodes.push(raw_node);
					cur_tnode = raw_node;
					return raw_node;
				}
				return pushRaw(cur_tnode, raw);
			}
		}

		// Helper: push a TNode into the current parent or slot
		function pushNodeHere(node: TNode) {
			const sc = getSlotCollection();
			if (sc) {
				const slotName = sc.currentSlot;
				if (!sc.partialRef.slots[slotName]) {
					sc.partialRef.slots[slotName] = [];
				}
				sc.partialRef.slots[slotName].push(node);
			} else {
				if (cur_tnode !== null) {
					cur_tnode.parent.tnodes!.push(node);
				} else if (currentPartialRoot !== null) {
					currentPartialRoot.tnodes.push(node);
				}
			}
		}

		const assetMap = options?.assetMap;
		const assetDirs = options?.assetDirs;

		// Helper: validate a static asset attribute value, returning parsed refs (no replacement)
		function validateStaticAssetAttr(attrName: string, value: string, tag: { sourceCodeLocation?: unknown }, origAttrName: string): { refs: AssetRef[], originalValue: string, error?: BackflipError } {
			if (!assetMap) {
				return { refs: [], originalValue: value, error: new BackflipError(`${attrName}~ used but no asset directories are configured`, attrErrorLoc(tag, origAttrName, filename)) };
			}
			if (attrName === 'style') {
				return { refs: [], originalValue: value, error: new BackflipError(`style~ is not supported`, attrErrorLoc(tag, origAttrName, filename)) };
			}
			if (attrName === 'srcset') {
				const entries = parseSrcsetEntries(value);
				const refs: AssetRef[] = [];
				for (const url of entries) {
					const ref = parseAssetRef(url);
					if (!ref) {
						return { refs: [], originalValue: value, error: new BackflipError(`asset path must start with @name: "${url}"`, attrErrorLoc(tag, origAttrName, filename)) };
					}
					const err = validateAssetRef(ref, assetMap, assetDirs, attrErrorLoc(tag, origAttrName, filename));
					if (err) return { refs: [], originalValue: value, error: err };
					refs.push(ref);
				}
				return { refs, originalValue: value };
			}
			// Single URL attribute
			const ref = parseAssetRef(value);
			if (!ref) {
				return { refs: [], originalValue: value, error: new BackflipError(`asset path must start with @name`, attrErrorLoc(tag, origAttrName, filename)) };
			}
			const err = validateAssetRef(ref, assetMap, assetDirs, attrErrorLoc(tag, origAttrName, filename));
			if (err) return { refs: [], originalValue: value, error: err };
			return { refs: [ref], originalValue: value };
		}

		// Helper: build tag prefix (no closing >) excluding certain attrs, b-data:*, bind attrs, and asset~ attrs
		function buildTagPrefix(tag: {tagName:string, attrs:{name:string,value:string}[], sourceCodeLocation?: unknown}, excludeAttrs: string[]): string {
			let tag_str = `<${tag.tagName}`;
			const processed: string[] = [];
			for (const attr of tag.attrs) {
				if (excludeAttrs.includes(attr.name) || attr.name.startsWith('b-data:') || isBindAttr(attr.name) || isAssetAttr(attr.name)) continue;
				processed.push(`${attr.name}="${attr.value}"`);
			}
			if (processed.length > 0) tag_str += ' ' + processed.join(' ');
			return tag_str;
		}

		// Helper: reconstruct tag string excluding certain attrs and all b-data: attrs
		function reconstructTagExcluding(tag: {tagName:string, attrs:{name:string,value:string}[], selfClosing:boolean, sourceCodeLocation?: unknown}, excludeAttrs: string[]): string {
			return buildTagPrefix(tag, excludeAttrs) + (tag.selfClosing ? ' />' : '>');
		}

		// Helper: make TNode(s) for a tag's open element.
		// Returns an array because tags with static asset attrs produce interleaved RawTNode + AssetRefTNode nodes.
		function makeOpenTagNode(tag: {tagName:string, attrs:{name:string,value:string}[], selfClosing:boolean, sourceCodeLocation?: unknown}, excludeAttrs: string[], parent: ParentTNode): TNode[] {
			if (tag.tagName === 'b-unwrap') {
				return [{ type: 'raw', raw: '', parent } as RawTNode];
			}
			const closeBracket = tag.selfClosing ? ' />' : '>';
			const hasBind = tag.attrs.some(attr => isBindAttr(attr.name));
			const hasAsset = tag.attrs.some(attr => !excludeAttrs.includes(attr.name) && isAssetAttr(attr.name));

			// Case A: no binds, no assets — single RawTNode
			if (!hasBind && !hasAsset) {
				return [{ type: 'raw', raw: buildTagPrefix(tag, excludeAttrs) + dataLocAttr(tag) + closeBracket, parent } as RawTNode];
			}

			// Case B: no binds, has static asset attrs — interleaved RawTNode + AssetRefTNode
			if (!hasBind) {
				const nodes: TNode[] = [];
				let buf = `<${tag.tagName}`;
				for (const attr of tag.attrs) {
					if (excludeAttrs.includes(attr.name) || attr.name.startsWith('b-data:')) continue;
					if (isAssetAttr(attr.name)) {
						const realName = stripAssetSuffix(attr.name);
						const { refs, originalValue, error } = validateStaticAssetAttr(realName, attr.value, tag, attr.name);
						if (error) {
							errors.push(error);
							continue;
						}
						// Flush buffer as RawTNode before the asset ref
						if (buf) { nodes.push({ type: 'raw', raw: buf, parent } as RawTNode); buf = ''; }
						nodes.push({ type: 'asset-ref', attrName: realName, originalValue, refs, parent, loc: attrLoc(tag, attr.name) } as AssetRefTNode);
					} else {
						buf += ` ${attr.name}="${attr.value}"`;
					}
				}
				buf += dataLocAttr(tag) + closeBracket;
				nodes.push({ type: 'raw', raw: buf, parent } as RawTNode);
				return nodes;
			}

			// Case C/D: has binds (possibly with static asset attrs and/or dynamic asset binds)
			const tagOpen = `<${tag.tagName}`;
			const parts: AttrPart[] = [];
			let staticBuf = '';
			for (const attr of tag.attrs) {
				if (excludeAttrs.includes(attr.name) || attr.name.startsWith('b-data:')) continue;
				if (isBindAttr(attr.name)) {
					if (staticBuf) { parts.push({ type: 'static', raw: staticBuf }); staticBuf = ''; }
					let bindName = getBindAttrName(attr.name);
					let isAssetBind = false;
					if (isAssetAttr(bindName)) {
						bindName = stripAssetSuffix(bindName);
						if (!assetMap) {
							errors.push(new BackflipError(`${bindName}~ used but no asset directories are configured`, attrErrorLoc(tag, attr.name, filename)));
							continue;
						}
						if (bindName === 'style') {
							errors.push(new BackflipError(`style~ is not supported`, attrErrorLoc(tag, attr.name, filename)));
							continue;
						}
						isAssetBind = true;
					}
					const part: AttrPart = { type: 'dynamic', name: bindName, expr: interpretBackcode(attr.value), isBoolean: BOOLEAN_ATTRS.has(bindName), loc: attrLoc(tag, attr.name) };
					if (isAssetBind) part.isAsset = true;
					parts.push(part);
				} else if (isAssetAttr(attr.name)) {
					const realName = stripAssetSuffix(attr.name);
					const { refs, originalValue, error } = validateStaticAssetAttr(realName, attr.value, tag, attr.name);
					if (error) {
						errors.push(error);
						continue;
					}
					// Flush staticBuf before pushing asset part
					if (staticBuf) { parts.push({ type: 'static', raw: staticBuf }); staticBuf = ''; }
					parts.push({ type: 'asset', attrName: realName, originalValue, refs, loc: attrLoc(tag, attr.name) });
				} else {
					staticBuf += ` ${attr.name}="${attr.value}"`;
				}
			}
			staticBuf += dataLocAttr(tag);
			if (staticBuf) parts.push({ type: 'static', raw: staticBuf });
			const node: AttrBindTNode = { type: 'attr-bind', tagOpen, parts, parent };
			if (tag.selfClosing) node.selfClosing = true;
			return [node];
		}

		function findPrecedingIfInFile(cur: TNode, loc?: { filename?: string, line?: number, col?: number }): IfTNode {
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

		function findPrecedingIfInSlot(arr: TNode[], loc?: { filename?: string, line?: number, col?: number }): IfTNode {
			for (let i = arr.length - 1; i >= 0; i--) {
				if (arr[i].type === 'if') return arr[i] as IfTNode;
				if (arr[i].type === 'raw' && (arr[i] as RawTNode).raw.trim() === '') continue;
				break;
			}
			throw new BackflipError("b-else-if/b-else must follow a b-if block", loc);
		}

		const void_elements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

		const rewriteStream = new RewritingStream();

		rewriteStream.on('startTag', (tag, raw) => { try {

			// --- b-name ---
			const bNameAttr = tag.attrs.find(a => a.name === 'b-name');
			if (bNameAttr !== undefined) {
				if (tag_stack.length > 0) {
					errors.push(new BackflipError("b-name is only allowed on top-level elements", attrErrorLoc(tag, 'b-name', filename)));
					// Treat as raw tag within current partial
					const new_cur = pushRawHere(raw);
					if (cur_tnode !== null) cur_tnode = new_cur;
					if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
						tag_stack.push({ tag: tag.tagName });
					}
					return;
				}

				const partialName = bNameAttr.value;
				const tagSrcLoc = tag.sourceCodeLocation as { startOffset?: number; startLine?: number; startCol?: number } | null | undefined;
				const partialRoot: RootTNode = { type: 'root', tnodes: [], meta: {
					startOffset: tagSrcLoc?.startOffset ?? 0,
					endOffset: tagSrcLoc?.startOffset ?? 0, // updated on close
					startLine: tagSrcLoc?.startLine ?? 1,
					startCol: tagSrcLoc?.startCol ?? 1,
					isDocumentLevel: DOCUMENT_LEVEL_TAGS.has(tag.tagName),
				} };
				partialRoot.loc = attrLoc(tag, 'b-name');
				partialRoot.exported = tag.attrs.some(a => a.name === 'b-export');
				compiledFile.partials.set(partialName, partialRoot);

				currentPartialRoot = partialRoot;
				currentPartialName = partialName;

				if (tag.tagName === 'b-unwrap') {
					// Don't emit opening tag; just track for closing
					const init_raw: RawTNode = { type: 'raw', raw: '', parent: partialRoot };
					partialRoot.tnodes.push(init_raw);
					cur_tnode = init_raw;
					if (!tag.selfClosing) {
						tag_stack.push({ tag: tag.tagName });
					}
				} else {
					const openNodes = makeOpenTagNode(tag, ['b-name', 'b-export'], partialRoot);
					for (const n of openNodes) partialRoot.tnodes.push(n);
					const lastOpen = openNodes[openNodes.length - 1];
					cur_tnode = lastOpen?.type === 'raw' ? lastOpen as RawTNode : null;
					if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
						tag_stack.push({ tag: tag.tagName });
					} else {
						// Self-closing or void element: end offset is end of this tag
						partialRoot.meta!.endOffset = (tagSrcLoc?.startOffset ?? 0) + raw.length;
					}
				}
				return;
			}

			// --- b-part ---
			const bPartAttr = tag.attrs.find(a => a.name === 'b-part');
			if (bPartAttr !== undefined) {
				// b-part outside any b-name partial is ignored
				if (cur_tnode === null && currentPartialRoot === null) {
					if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
						tag_stack.push({ tag: tag.tagName });
					}
					return;
				}
				const partValue = bPartAttr.value;
				let file: string | null;
				let partialName: string;
				if (partValue.startsWith('#')) {
					file = null;
					partialName = partValue.slice(1);
				} else {
					const hashIdx = partValue.indexOf('#');
					if (hashIdx === -1) {
						file = null;
						partialName = partValue;
					} else {
						file = partValue.slice(0, hashIdx);
						partialName = partValue.slice(hashIdx + 1);
					}
				}

				const bindings: PartialBinding[] = [];
				for (const attr of tag.attrs) {
					if (attr.name.startsWith('b-data:')) {
						const bindingName = attr.name.slice('b-data:'.length);
						bindings.push({ name: bindingName, data: interpretBackcode(attr.value) });
					}
				}

				let wrapper: { open: string, close: string } | null;
				if (tag.tagName === 'b-unwrap') {
					wrapper = null;
				} else {
					const open = buildTagPrefix(tag, ['b-part']) + dataLocAttr(tag) + (tag.selfClosing ? ' />' : '>');
					wrapper = { open, close: `</${tag.tagName}>` };
				}

				const parent: ParentTNode = cur_tnode ? cur_tnode.parent : currentPartialRoot!;

				const partialRef: PartialRefTNode = {
					type: 'partial-ref',
					file,
					partialName,
					wrapper,
					slots: { 'default': [] },
					slotLocs: {},
					bindings,
					parent
				};
				partialRef.loc = attrLoc(tag, 'b-part');

				pushNodeHere(partialRef);
				// After pushing, update cur_tnode so subsequent siblings work
				// We use a placeholder raw node in the same parent for after the partial-ref closes
				// But during slot collection, cur_tnode isn't used

				if (!tag.selfClosing && tag.tagName !== 'b-unwrap' || tag.tagName === 'b-unwrap' && !tag.selfClosing) {
					tag_stack.push({
						tag: tag.tagName,
						tnode: partialRef,
						slotCollection: {
							partialRef,
							currentSlot: 'default'
						}
					});
				}
				return;
			}

			// --- b-slot ---
			const bSlotAttr = tag.attrs.find(a => a.name === 'b-slot');
			if (bSlotAttr !== undefined) {
				// b-slot outside any b-name partial is ignored
				if (cur_tnode === null && currentPartialRoot === null) {
					if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
						tag_stack.push({ tag: tag.tagName });
					}
					return;
				}
				const slotName = bSlotAttr.value !== '' ? bSlotAttr.value : undefined;
				const parent: ParentTNode = cur_tnode ? cur_tnode.parent : currentPartialRoot!;

				const slot_node: SlotTNode = { type: 'slot', name: slotName, parent };
				slot_node.loc = attrLoc(tag, 'b-slot');

				if (cur_tnode !== null) {
					cur_tnode.parent.tnodes!.push(slot_node);
				} else if (currentPartialRoot !== null) {
					currentPartialRoot.tnodes.push(slot_node);
				}
				cur_tnode = slot_node as unknown as TNode;

				if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
					// Push to tag_stack so endTag is consumed correctly.
					// For b-unwrap b-slot, don't store tnode so endTag has no special effect.
					if (tag.tagName === 'b-unwrap') {
						tag_stack.push({ tag: tag.tagName });
					} else {
						tag_stack.push({ tag: tag.tagName, tnode: slot_node as unknown as TNode });
					}
				}
				return;
			}

			// --- b-in inside slot-collection context ---
			const bInAttr = tag.attrs.find(a => a.name === 'b-in');
			if (bInAttr !== undefined) {
				const innermost = getSlotCollection();
				if (innermost) {
					const slotName = bInAttr.value || 'default';
					if (!innermost.partialRef.slots[slotName]) {
						innermost.partialRef.slots[slotName] = [];
					}
					const bInLoc = attrLoc(tag, 'b-in');
					if (bInLoc) {
						if (!innermost.partialRef.slotLocs) innermost.partialRef.slotLocs = {};
						innermost.partialRef.slotLocs[slotName] = bInLoc;
					}
					tag_stack.push({
						tag: tag.tagName,
						slotCollection: {
							partialRef: innermost.partialRef,
							currentSlot: slotName
						}
					});
					// For non-b-unwrap elements, emit the opening tag into the slot
					if (tag.tagName !== 'b-unwrap') {
						pushRawHere(buildTagPrefix(tag, ['b-in']) + dataLocAttr(tag) + '>');
					}
					return;
				}
			}

			// Skip everything outside a partial
			if (cur_tnode === null && currentPartialRoot === null) {
				if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
					tag_stack.push({ tag: tag.tagName });
				}
				return;
			}

			// Track document-level tags inside partials
			if (currentPartialRoot !== null && DOCUMENT_LEVEL_TAGS.has(tag.tagName)) {
				currentPartialRoot.meta!.isDocumentLevel = true;
			}

			// --- standard b-for / b-if / b-else-if / b-else ---
			const b_as = tag.attrs.filter(attr => ['b-for', 'b-if', 'b-else-if', 'b-else'].includes(attr.name));
			if (b_as.length > 1) {
				errors.push(new BackflipError("more than one b-attr", errorLoc(filename, tagLoc(tag))));
				const new_cur = pushRawHere(raw);
				if (cur_tnode !== null) cur_tnode = new_cur;
				if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
					tag_stack.push({ tag: tag.tagName });
				}
				return;
			}

			if (b_as.length === 1) {
				const b_a = b_as[0];
				if (b_a.name === 'b-for') {
					const pieces = b_a.value.split(" in ");
					if (pieces.length !== 2) {
						errors.push(new BackflipError(`b-for value must be in the form "item in items", got: "${b_a.value}"`, attrErrorLoc(tag, 'b-for', filename)));
						const new_cur = pushRawHere(raw);
						if (cur_tnode !== null) cur_tnode = new_cur;
						if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
							tag_stack.push({ tag: tag.tagName });
						}
						return;
					}
					const iterable_parsed = interpretBackcode(pieces[1].trim());
					const value_name = pieces[0].trim();
					if (!value_name) {
						errors.push(new BackflipError(`got bad iter value name: ${value_name}`, attrErrorLoc(tag, 'b-for', filename)));
						const new_cur = pushRawHere(raw);
						if (cur_tnode !== null) cur_tnode = new_cur;
						if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
							tag_stack.push({ tag: tag.tagName });
						}
						return;
					}

					const sc_for = getSlotCollection();
					const parent: ParentTNode = sc_for ? sc_for.partialRef.parent : (cur_tnode ? cur_tnode.parent : currentPartialRoot!);
					const for_node: ForTNode = { type: 'for', iterable: iterable_parsed, valName: value_name, tnodes: [], parent };
					for_node.loc = attrLoc(tag, 'b-for');
					const inner_tags = makeOpenTagNode(tag, ['b-for'], for_node);
					for (const n of inner_tags) for_node.tnodes.push(n);
					if (sc_for) {
						pushNodeHere(for_node);
					} else {
						parent.tnodes!.push(for_node);
					}
					const lastFor = inner_tags[inner_tags.length - 1];
					cur_tnode = lastFor ?? null;
					if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
						tag_stack.push({ tag: tag.tagName, tnode: lastFor });
					}
				}
				else if (b_a.name === 'b-if') {
					const sc_if = getSlotCollection();
					const parent: ParentTNode = sc_if ? sc_if.partialRef.parent : (cur_tnode ? cur_tnode.parent : currentPartialRoot!);
					const if_node: IfTNode = { type: 'if', branches: [], parent };
					const branch: IfBranch = { condition: interpretBackcode(b_a.value), tnodes: [], ifNode: if_node };
					branch.loc = attrLoc(tag, 'b-if');
					if_node.branches.push(branch);
					const inner_tags_if = makeOpenTagNode(tag, ['b-if'], branch);
					for (const n of inner_tags_if) branch.tnodes.push(n);
					if (sc_if) {
						pushNodeHere(if_node);
					} else {
						parent.tnodes!.push(if_node);
					}
					const lastIf = inner_tags_if[inner_tags_if.length - 1];
					cur_tnode = lastIf ?? null;
					if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
						tag_stack.push({ tag: tag.tagName, tnode: lastIf });
					}
				}
				else if (b_a.name === 'b-else-if' || b_a.name === 'b-else') {
					if (!cur_tnode) {
						errors.push(new BackflipError("b-else-if/b-else must follow a b-if block", attrErrorLoc(tag, b_a.name, filename)));
						const new_cur = pushRawHere(raw);
						if (cur_tnode !== null) cur_tnode = new_cur;
						if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
							tag_stack.push({ tag: tag.tagName });
						}
						return;
					}
					let if_node: IfTNode;
					const sc_else = getSlotCollection();
					try {
						if (sc_else) {
							const slotName = sc_else.currentSlot;
							const arr = sc_else.partialRef.slots[slotName] || [];
							if_node = findPrecedingIfInSlot(arr, attrErrorLoc(tag, b_a.name, filename));
						} else {
							if_node = findPrecedingIfInFile(cur_tnode, attrErrorLoc(tag, b_a.name, filename));
						}
					} catch (e) {
						if (e instanceof BackflipError) {
							errors.push(e);
							const new_cur = pushRawHere(raw);
							if (cur_tnode !== null) cur_tnode = new_cur;
							if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
								tag_stack.push({ tag: tag.tagName });
							}
							return;
						}
						throw e;
					}
					if (b_a.name === 'b-else' && b_a.value) {
						errors.push(new BackflipError("b-else should not have a value", attrErrorLoc(tag, 'b-else', filename)));
						// Still process as b-else (parsing state stays correct)
					}
					const condition = b_a.name === 'b-else-if' ? interpretBackcode(b_a.value) : undefined;
					const branch: IfBranch = { condition, tnodes: [], ifNode: if_node };
					branch.loc = attrLoc(tag, b_a.name);
					if_node.branches.push(branch);
					const inner_tags_else = makeOpenTagNode(tag, [b_a.name], branch);
					for (const n of inner_tags_else) branch.tnodes.push(n);
					const lastElse = inner_tags_else[inner_tags_else.length - 1];
					cur_tnode = lastElse ?? null;
					if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
						tag_stack.push({ tag: tag.tagName, tnode: lastElse });
					}
				}
			}
			else {
				// Regular tag — check for bind attrs or asset attrs
				const hasBindAttrs = tag.attrs.some(attr => isBindAttr(attr.name));
				const hasAssetAttrs = tag.attrs.some(attr => isAssetAttr(attr.name));
				if (hasBindAttrs || hasAssetAttrs) {
					const parent: ParentTNode = cur_tnode ? cur_tnode.parent : currentPartialRoot!;
					const nodes = makeOpenTagNode(tag, [], parent);
					for (const n of nodes) pushNodeHere(n);
					const lastNode = nodes[nodes.length - 1];
					cur_tnode = lastNode ?? null;
					if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
						tag_stack.push({ tag: tag.tagName });
					}
				} else {
					const loc = dataLocAttr(tag);
					const tagRaw = loc ? raw.replace(/(\s*\/?)>$/, loc + '$1>') : raw;  // preserves self-closing />
					const new_cur = pushRawHere(tagRaw);
					if (cur_tnode !== null) cur_tnode = new_cur;
					if (!tag.selfClosing && !void_elements.has(tag.tagName)) {
						tag_stack.push({ tag: tag.tagName });
					}
				}
			}
		} catch(e) { if (e instanceof BackflipError) { errors.push(e); } else { reject(e); } } });

		rewriteStream.on('endTag', (tag, raw) => { try {
			const matchTag = tag_stack.pop();
			if (!matchTag) {
				errors.push(new BackflipError("popped the last tagMatcher prematurely", errorLoc(filename, tagLoc(tag))));
				if (cur_tnode !== null) cur_tnode = pushRaw(cur_tnode, raw);
				else if (currentPartialRoot !== null) pushRawHere(raw);
				return;
			}
			if (matchTag.tag !== tag.tagName) {
				errors.push(new BackflipError(`mismatched start/end tags: ${matchTag.tag} ${tag.tagName}`, errorLoc(filename, tagLoc(tag))));
				tag_stack.push(matchTag);
				if (cur_tnode !== null) cur_tnode = pushRaw(cur_tnode, raw);
				else if (currentPartialRoot !== null) pushRawHere(raw);
				return;
			}

			// If we just closed the partial's top-level element
			if (tag_stack.length === 0 && currentPartialRoot !== null) {
				if (tag.tagName !== 'b-unwrap') {
					pushRawHere(raw);
				}
				// Record end offset of the partial
				const endTagLoc = tag.sourceCodeLocation as { startOffset?: number } | null | undefined;
				currentPartialRoot.meta!.endOffset = (endTagLoc?.startOffset ?? 0) + raw.length;
				// End of this partial
				currentPartialRoot = null;
				currentPartialName = null;
				cur_tnode = null;
				return;
			}

			// If this was a slotCollection entry
			if (matchTag.slotCollection) {
				const tnode = matchTag.tnode;
				if (tnode && tnode.type === 'partial-ref') {
					// b-part closing - create a new raw node in partialRef's parent for subsequent content
					const parent = tnode.parent;
					const new_raw: RawTNode = { type: 'raw', raw: '', parent };
					parent.tnodes!.push(new_raw);
					cur_tnode = new_raw;
				}
				// b-in closing - emit closing tag for non-b-unwrap elements
				else if (matchTag.tag !== 'b-unwrap') {
					const sc = matchTag.slotCollection!;
					const slotName = sc.currentSlot;
					const arr = sc.partialRef.slots[slotName];
					const lastNode = arr.length > 0 ? arr[arr.length - 1] : null;
					if (lastNode && lastNode.type === 'raw') {
						(lastNode as RawTNode).raw += raw;
					} else {
						const raw_node: RawTNode = { type: 'raw', raw, parent: sc.partialRef.parent };
						arr.push(raw_node);
					}
				}
				return;
			}

			// Regular closing
			if (matchTag.tnode) {
				// Close tag belongs to the structured node (b-for/b-if/b-slot), not the slot
				if (cur_tnode !== null && tag.tagName !== 'b-unwrap') {
					cur_tnode = pushRaw(cur_tnode, raw);
				}
			} else {
				const sc = getSlotCollection();
				if (sc) {
					pushRawHere(raw);
				} else if (cur_tnode !== null) {
					cur_tnode = pushRaw(cur_tnode, raw);
				}
			}

			if (matchTag.tnode) {
				if (!matchTag.tnode.parent) throw new BackflipError("expected a parent");
				const parent = matchTag.tnode.parent;
				if ('ifNode' in parent) {
					cur_tnode = (parent as IfBranch).ifNode as unknown as TNode;
				} else {
					cur_tnode = parent as TNode;
				}
			}
		} catch(e) { if (e instanceof BackflipError) { errors.push(e); } else { reject(e); } } });

		rewriteStream.on('text', (textToken: {sourceCodeLocation?: {startLine:number;startCol:number;startOffset:number}|null}, raw: string) => { try {
			if (cur_tnode === null && currentPartialRoot === null) return; // outside any partial

			const textLoc = textToken.sourceCodeLocation ?? undefined;

			const sc = getSlotCollection();
			if (sc) {
				// Insert text (with {{ }} support) into current slot
				const slotName = sc.currentSlot;
				if (!sc.partialRef.slots[slotName]) {
					sc.partialRef.slots[slotName] = [];
				}
				const arr = sc.partialRef.slots[slotName];
				const dummyParent = sc.partialRef.parent;

				const matches = raw.matchAll(cf_text_regex);
				let raw_it = 0;
				for (const m of matches) {
					if (m.index > raw_it) {
						const sub = raw.substring(raw_it, m.index);
						const last = arr.length > 0 ? arr[arr.length - 1] : null;
						if (last && last.type === 'raw') { (last as RawTNode).raw += sub; }
						else { arr.push({ type: 'raw', raw: sub, parent: dummyParent }); }
					}
					const code_str = m[0].substring(2, m[0].length - 2).trim();
					if (!code_str) {
						const last = arr.length > 0 ? arr[arr.length - 1] : null;
						if (last && last.type === 'raw') { (last as RawTNode).raw += m[0]; }
						else { arr.push({ type: 'raw', raw: m[0], parent: dummyParent }); }
						raw_it = m.index + m[0].length;
						continue;
					}
					const print_node: PrintTNode = { type: 'print', data: interpretBackcode(code_str), parent: dummyParent };
					if (textLoc) print_node.loc = interpolationLoc(textLoc, raw.substring(0, m.index), m[0]);
					arr.push(print_node);
					raw_it = m.index + m[0].length;
				}
				if (raw_it < raw.length) {
					const sub = raw.substring(raw_it);
					const last = arr.length > 0 ? arr[arr.length - 1] : null;
					if (last && last.type === 'raw') { (last as RawTNode).raw += sub; }
					else { arr.push({ type: 'raw', raw: sub, parent: dummyParent }); }
				}
			} else if (cur_tnode !== null) {
				cur_tnode = onText(cur_tnode, raw, textLoc);
			}
		} catch(e) { if (e instanceof BackflipError) { errors.push(e); } else { reject(e); } } });

		s.pipe(rewriteStream);
		s.on('error', (err) => { reject(err); });
		rewriteStream.on('error', (err) => { reject(err); });
		rewriteStream.on('end', () => {
			// Post-processing: infer data shapes and free variables for each partial
			for (const [, root] of compiledFile.partials) {
				const shape = inferDataShape(root);
				root.dataShape = shape;
				root.freeVars = [...shape.keys()].sort();
			}
			resolve({ compiled: compiledFile, errors });
		});
	});
}

const cf_text_regex = new RegExp("({{[^{}]*}})", 'g');

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
			...(root.freeVars ? { freeVars: root.freeVars } : {}),
			...(root.dataShape ? { dataShape: root.dataShape } : {}),
			...(root.meta ? { meta: root.meta } : {}),
		};
		newRoot.tnodes = resolveTNodes(root.tnodes, newRoot, assetMap);
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
				result.push(newNode);
				break;
			}
			case 'attr-bind': {
				const n = node as AttrBindTNode;
				const newParts: AttrPart[] = resolveAttrParts(n.parts, assetMap);
				const newNode: AttrBindTNode = { type: 'attr-bind', tagOpen: n.tagOpen, parts: newParts, parent };
				if (n.selfClosing) newNode.selfClosing = true;
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
