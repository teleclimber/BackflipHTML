import type { SourceLoc } from './types.js';

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

/**
 * Convert parse5's tag.sourceCodeLocation into our SourceLoc (best effort —
 * returns undefined if the parser didn't supply line/col info). `fallbackLen`
 * is the length added to `startOffset` when the parser didn't supply an
 * `endOffset` (defaults to 0). Call sites that reconstruct a tag from its raw
 * text pass `raw.length` so the fallback span covers the whole tag.
 */
export function tagSrcLoc(tag: { sourceCodeLocation?: unknown }, fallbackLen: number = 0): SourceLoc | undefined {
	const loc = tag.sourceCodeLocation as { startLine?: number; startCol?: number; startOffset?: number; endLine?: number; endCol?: number; endOffset?: number } | null | undefined;
	if (!loc || loc.startLine == null) return undefined;
	const startOffset = loc.startOffset ?? 0;
	return {
		startLine: loc.startLine,
		startCol: loc.startCol ?? 1,
		startOffset,
		endLine: loc.endLine ?? loc.startLine,
		endCol: loc.endCol ?? (loc.startCol ?? 1),
		endOffset: loc.endOffset ?? (startOffset + fallbackLen),
	};
}

export function errorLoc(filename?: string, loc?: { line?: number, col?: number }): { filename?: string, line?: number, col?: number } | undefined {
	if (!filename && !loc?.line) return undefined;
	return { filename, line: loc?.line, col: loc?.col };
}

/**
 * Error location for a diagnostic about one attribute: the attr's own span when
 * the parser provided one, else the open tag's position. Both locations are
 * pre-converted `SourceLoc`s (from parse-tree.ts) — this module no longer
 * reaches into parse5 objects for error positions.
 */
export function attrErrorLoc(a: SourceLoc | undefined, openLoc: SourceLoc | undefined, filename?: string): { filename?: string, line?: number, col?: number, endLine?: number, endCol?: number } | undefined {
	if (a) return { filename, line: a.startLine, col: a.startCol, endLine: a.endLine, endCol: a.endCol };
	return errorLoc(filename, { line: openLoc?.startLine, col: openLoc?.startCol });
}

/**
 * Compute the source location of just the NAME portion of a `b-data:NAME` attribute,
 * starting after the `b-data:` prefix and ending at the close of the name. Returns
 * undefined when no parser-provided location is available. `a` is the location
 * of the whole attribute.
 */
export function bDataNameLoc(a: SourceLoc | undefined, bindingName: string): SourceLoc | undefined {
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

/**
 * Advance a start anchor over `prefix` text: lines by the newline count,
 * column restarting after the last newline (1-based). Slices are complete
 * lines, so an advanced anchor stays file-correct when the input one was.
 */
export function advanceLoc(
	start: { startLine: number; startCol: number; startOffset: number },
	prefix: string,
): { startLine: number; startCol: number; startOffset: number } {
	const newlines = (prefix.match(/\n/g) ?? []).length;
	const lastNl = prefix.lastIndexOf('\n');
	return {
		startLine: start.startLine + newlines,
		startCol: lastNl === -1 ? start.startCol + prefix.length : prefix.length - lastNl,
		startOffset: start.startOffset + prefix.length,
	};
}

export function interpolationLoc(
	textLoc: { startLine: number; startCol: number; startOffset: number },
	rawBefore: string,
	matchStr: string
): SourceLoc {
	const { startLine, startCol, startOffset } = advanceLoc(textLoc, rawBefore);
	return {
		startLine, startCol, startOffset,
		endLine: startLine, endCol: startCol + matchStr.length, endOffset: startOffset + matchStr.length,
	};
}

/**
 * Build the `data-loc="file#partial:line:col"` attribute appended to rendered open tags
 * when source-location tracking is on. Returns '' when locations are disabled, when no
 * partial is currently being compiled, or when the parser didn't provide a location.
 */
export function dataLocAttr(
	loc: { startLine?: number; startCol?: number } | undefined,
	ctx: { includeLocs: boolean; currentPartialName: string | null; filename?: string },
): string {
	if (!ctx.includeLocs || !ctx.currentPartialName) return '';
	if (!loc?.startLine) return '';
	const file = ctx.filename ?? '';
	return ` data-loc="${file}#${ctx.currentPartialName}:${loc.startLine}:${loc.startCol}"`;
}
