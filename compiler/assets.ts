import { BackflipError } from './errors.js';
import { mapTNodes } from './walk.js';
import { LineMap, attrErrorLoc } from './loc.js';
import type {
	SourceLoc,
	AssetRef,
	TNode,
	AttrPart,
	RootTNode,
	CustomElementPartialRoot,
	CompiledFile,
	LocBase,
} from './types.js';

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
	html: string;      // the partial's slice text
	lineMap: LineMap;  // over `html`, so slice-relative
	// Rebase buildSourceTree applied to all locs (see LocBase in types.ts).
	// Incoming attr/tag locs already carry it; locs computed here from `html`
	// and `lineMap` are slice-relative and must add it before being emitted.
	locBase: LocBase;
	assetMap?: Map<string, string>;
	assetDirs?: Map<string, string>;
	filename?: string;
}

/**
 * Validate a static asset attribute value, returning the parsed refs (no replacement).
 * The returned `error` is non-null when the attribute is malformed or the asset directory
 * is unknown; otherwise `refs` carries one entry per URL (1 for src~, N for srcset~).
 *
 * `attrLocation` is the attribute's pre-converted SourceLoc (from
 * parse-tree.ts); `openLoc` is the open tag's, used as the error-location
 * fallback when the attr has none.
 */
export function validateStaticAssetAttr(
	attrName: string,
	value: string,
	attrLocation: SourceLoc | undefined,
	openLoc: SourceLoc | undefined,
	ctx: AssetAttrCtx,
): { refs: AssetRef[], originalValue: string, error?: BackflipError } {
	const { html, lineMap, locBase, assetMap, assetDirs, filename } = ctx;
	if (!assetMap) {
		return { refs: [], originalValue: value, error: new BackflipError(`${attrName}~ used but no asset directories are configured`, attrErrorLoc(attrLocation, openLoc, filename)) };
	}
	if (attrName === 'style') {
		return { refs: [], originalValue: value, error: new BackflipError(`style~ is not supported`, attrErrorLoc(attrLocation, openLoc, filename)) };
	}

	// Slice-relative offset of the attr value inside `html`. attrLocation is
	// already rebased (file-relative), so the base is subtracted for the
	// substring arithmetic and added back when locs are emitted below.
	let valueStartOffset = 0;
	if (attrLocation) {
		const attrStart = attrLocation.startOffset - locBase.offset;
		const attrText = html.substring(attrStart, attrLocation.endOffset - locBase.offset);
		const relativeValueOffset = attrText.indexOf(value);
		if (relativeValueOffset !== -1) {
			valueStartOffset = attrStart + relativeValueOffset;
		} else {
			valueStartOffset = attrStart; // fallback
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
			// Slice-relative offsets into html/lineMap; rebased on emit.
			const absStart = valueStartOffset + localOffset;
			const absEnd = absStart + val.length;
			const startLoc = lineMap.getLoc(absStart);
			const endLoc = lineMap.getLoc(absEnd);
			ref.loc = {
				startLine: startLoc.line + locBase.line, startCol: startLoc.col, startOffset: absStart + locBase.offset,
				endLine: endLoc.line + locBase.line, endCol: endLoc.col, endOffset: absEnd + locBase.offset
			};

			const subpathAbsStart = absStart + slashIdx + 1;
			const subpathStartLoc = lineMap.getLoc(subpathAbsStart);
			ref.subpathLoc = {
				startLine: subpathStartLoc.line + locBase.line, startCol: subpathStartLoc.col, startOffset: subpathAbsStart + locBase.offset,
				endLine: endLoc.line + locBase.line, endCol: endLoc.col, endOffset: absEnd + locBase.offset
			};
		}
		return ref;
	}

	function getErrLoc(refLoc: SourceLoc | undefined): { filename?: string, line?: number, col?: number, endLine?: number, endCol?: number } | undefined {
		if (refLoc) {
			return { filename, line: refLoc.startLine, col: refLoc.startCol, endLine: refLoc.endLine, endCol: refLoc.endCol };
		}
		return attrErrorLoc(attrLocation, openLoc, filename);
	}

	if (attrName === 'srcset') {
		const entries = parseSrcsetEntriesWithOffsets(value);
		const refs: AssetRef[] = [];
		for (const { url, offset } of entries) {
			const ref = createAssetRef(url, offset);
			if (!ref) {
				return { refs: [], originalValue: value, error: new BackflipError(`asset path must start with @name: "${url}"`, attrErrorLoc(attrLocation, openLoc, filename)) };
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
		return { refs: [], originalValue: value, error: new BackflipError(`asset path must start with @name`, attrErrorLoc(attrLocation, openLoc, filename)) };
	}
	const errLoc = getErrLoc(ref.loc);
	const err = validateAssetRef(ref, assetMap, assetDirs, errLoc);
	if (err) return { refs: [], originalValue: value, error: err };
	return { refs: [ref], originalValue: value };
}

// --- asset resolution (stage 2) ---

/**
 * Stage 2: Resolve `asset` AttrParts in a compiled AST using an asset map.
 * Returns a new CompiledFile with `asset` parts replaced by `static` parts
 * (their fully-resolved URLs). The input CompiledFile is not mutated.
 */
export function resolveAssetRefs(compiled: CompiledFile, assetMap: Map<string, string>): CompiledFile {
	const newPartials = new Map<string, RootTNode>();
	for (const [name, root] of compiled.partials) {
		const newRoot: RootTNode = root.kind === 'custom-element'
			? {
				type: 'root',
				kind: 'custom-element',
				tnodes: [],
				...(root.loc ? { loc: root.loc } : {}),
				...(root.exported !== undefined ? { exported: root.exported } : {}),
				...(root.definitionAttrNames ? { definitionAttrNames: root.definitionAttrNames } : {}),
				...(root.bAttrs ? { bAttrs: root.bAttrs } : {}),
				// Rewrite each script's @name/... prefix (no-op for already-absolute dependency URLs).
				...(root.scripts ? { scripts: root.scripts.map(s => ({ ...s, url: replaceAssetRef(s.url, assetMap) })) } : {}),
				...(root.meta ? { meta: root.meta } : {}),
			}
			: {
				type: 'root',
				kind: 'named',
				tnodes: [],
				...(root.loc ? { loc: root.loc } : {}),
				...(root.exported !== undefined ? { exported: root.exported } : {}),
				...(root.meta ? { meta: root.meta } : {}),
			};
		// Resolve asset AttrParts node-locally; mapTNodes handles the structural copy
		// (and adjacent-raw coalescing) generically, so new TNode fields survive via spread.
		newRoot.tnodes = mapTNodes(root.tnodes, (n) => resolveNodeAssets(n, assetMap), { coalesceRaws: true });
		if (root.kind === 'custom-element' && root.definitionAttrs) {
			(newRoot as CustomElementPartialRoot).definitionAttrs = resolveAttrParts(root.definitionAttrs, assetMap);
		}
		newPartials.set(name, newRoot);
	}
	return { partials: newPartials };
}

/** Node-local asset resolution: rewrite element attrs and custom-element caller attrs. */
function resolveNodeAssets(n: TNode, assetMap: Map<string, string>): TNode {
	if (n.type === 'element') {
		return { ...n, attrs: resolveAttrParts(n.attrs, assetMap) };
	}
	if (n.type === 'partial-ref' && n.kind === 'custom-element' && n.callerAttrs) {
		return { ...n, callerAttrs: resolveAttrParts(n.callerAttrs, assetMap) };
	}
	return n;
}

export function resolveAttrParts(parts: AttrPart[], assetMap: Map<string, string>): AttrPart[] {
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
