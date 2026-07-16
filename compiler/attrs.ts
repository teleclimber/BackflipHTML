import { interpretBackcode } from './backcode.js';
import type { Parsed } from './backcode.js';
import { BackflipError } from './errors.js';
import { attrErrorLoc } from './loc.js';
import { validateStaticAssetAttr, type AssetAttrCtx } from './assets.js';
import type { SourceLoc, AssetRef, AttrPart } from './types.js';
import type { SourceAttr } from './parse-tree.js';

// --- tag sets ---

export const BOOLEAN_ATTRS = new Set([
	'allowfullscreen','async','autofocus','autoplay','checked','controls',
	'default','defer','disabled','formnovalidate','hidden','ismap','loop',
	'multiple','muted','nomodule','novalidate','open','readonly','required',
	'reversed','selected'
]);

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
 * Walk an element's attrs once, filtering b-name/b-export/etc. (`excludeAttrs`),
 * b-data:*, and b-attr:*, validating any static asset attrs, and emitting a
 * normalized AttrSegment stream. `hasBind` tells the caller whether the
 * output should be a Raw + AssetRef sequence (no binds) or a single
 * AttrBindTNode (binds present). Validation errors are returned as data
 * rather than thrown or mutated into a shared array.
 *
 * `el` is the SourceElement shape produced by parse-tree.ts (attrs with
 * pre-converted locs, plus the open tag's loc for error fallbacks).
 */
export function classifyOpenTagAttrs(
	el: { attrs: Pick<SourceAttr, 'name' | 'value' | 'loc' | 'valueLoc'>[], openLoc?: SourceLoc },
	excludeAttrs: string[],
	ctx: AssetAttrCtx,
): { segments: AttrSegment[], hasBind: boolean, errors: BackflipError[] } {
	const segments: AttrSegment[] = [];
	const errors: BackflipError[] = [];
	let hasBind = false;
	for (const attr of el.attrs) {
		if (excludeAttrs.includes(attr.name) || attr.name.startsWith('b-data:') || attr.name.startsWith('b-attr:') || attr.name === 'b-script') continue;
		if (isBindAttr(attr.name)) {
			let bindName = getBindAttrName(attr.name);
			let isAsset = false;
			if (isAssetAttr(bindName)) {
				bindName = stripAssetSuffix(bindName);
				if (!ctx.assetMap) {
					errors.push(new BackflipError(`${bindName}~ used but no asset directories are configured`, attrErrorLoc(attr.loc, el.openLoc, ctx.filename)));
					continue;
				}
				if (bindName === 'style') {
					errors.push(new BackflipError(`style~ is not supported`, attrErrorLoc(attr.loc, el.openLoc, ctx.filename)));
					continue;
				}
				isAsset = true;
			}
			hasBind = true;
			const expr = interpretBackcode(attr.value);
			for (const err of expr.errs) {
				errors.push(new BackflipError(err, attrErrorLoc(attr.loc, el.openLoc, ctx.filename)));
			}
			segments.push({
				kind: 'bind',
				name: bindName,
				expr,
				isBoolean: BOOLEAN_ATTRS.has(bindName),
				isAsset,
				loc: attr.loc,
			});
		} else if (isAssetAttr(attr.name)) {
			const realName = stripAssetSuffix(attr.name);
			const { refs, originalValue, error } = validateStaticAssetAttr(realName, attr, el.openLoc, ctx);
			if (error) { errors.push(error); continue; }
			segments.push({
				kind: 'asset',
				attrName: realName,
				originalValue,
				refs,
				loc: attr.loc,
			});
		} else {
			segments.push({ kind: 'static', text: ` ${attr.name}="${attr.value}"` });
		}
	}
	return { segments, hasBind, errors };
}

/**
 * Convert a normalized `AttrSegment[]` (from classifyOpenTagAttrs) into an `AttrPart[]`
 * suitable for `ElementTNode.attrs` (or `definitionAttrs` / `callerAttrs` on custom-element
 * roots/calls). `trailingStatic` is appended into the final static part (used to inject
 * the `data-loc=...` attribute when source-location tracking is on).
 */
export function buildAttrParts(segments: AttrSegment[], trailingStatic: string = ''): AttrPart[] {
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
	if (trailingStatic) staticBuf += trailingStatic;
	if (staticBuf) parts.push({ type: 'static', raw: staticBuf });
	return parts;
}
