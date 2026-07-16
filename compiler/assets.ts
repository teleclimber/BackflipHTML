import { BackflipError } from './errors.js';
import { mapTNodes } from './walk.js';
import { attrErrorLoc, interpolationLoc } from './loc.js';
import type {
	SourceLoc,
	AssetRef,
	TNode,
	AttrPart,
	RootTNode,
	CustomElementPartialRoot,
	CompiledFile,
} from './types.js';
import type { SourceAttr } from './parse-tree.js';

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
	assetMap?: Map<string, string>;
	assetDirs?: Map<string, string>;
	filename?: string;
}

/**
 * Validate a static asset attribute value, returning the parsed refs (no replacement).
 * The returned `error` is non-null when the attribute is malformed or the asset directory
 * is unknown; otherwise `refs` carries one entry per URL (1 for src~, N for srcset~).
 *
 * `attr` is the SourceAttr shape from parse-tree.ts: its `valueLoc` anchors
 * the emitted ref locs; `openLoc` is the open tag's loc, used as the
 * error-location fallback when the attr has none. `attrName` is the display
 * name (the real name, `~` stripped).
 */
export function validateStaticAssetAttr(
	attrName: string,
	attr: Pick<SourceAttr, 'value' | 'loc' | 'valueLoc'>,
	openLoc: SourceLoc | undefined,
	ctx: AssetAttrCtx,
): { refs: AssetRef[], originalValue: string, error?: BackflipError } {
	const { assetMap, assetDirs, filename } = ctx;
	const { value, loc: attrLocation, valueLoc } = attr;
	if (!assetMap) {
		return { refs: [], originalValue: value, error: new BackflipError(`${attrName}~ used but no asset directories are configured`, attrErrorLoc(attrLocation, openLoc, filename)) };
	}
	if (attrName === 'style') {
		return { refs: [], originalValue: value, error: new BackflipError(`style~ is not supported`, attrErrorLoc(attrLocation, openLoc, filename)) };
	}

	function createAssetRef(val: string, localOffset: number): AssetRef | null {
		if (!val.startsWith('@')) return null;
		const slashIdx = val.indexOf('/');
		if (slashIdx === -1) return null;

		const name = val.slice(1, slashIdx);
		const subpath = val.slice(slashIdx + 1);

		const ref: AssetRef = { name, subpath };

		if (valueLoc) {
			ref.loc = interpolationLoc(valueLoc, value.slice(0, localOffset), val);
			ref.subpathLoc = interpolationLoc(valueLoc, value.slice(0, localOffset + slashIdx + 1), subpath);
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
