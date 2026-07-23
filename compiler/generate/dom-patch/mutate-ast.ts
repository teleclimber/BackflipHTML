import type { AttrPart, CustomElementCallTNode, ElementTNode, TNode } from '../../types.js';
import { commentMarker, type BfidGen } from './bfid.js';
import { isIfSetSite, type Site } from './collect.js';

const BFID_RE = /\sdata-bfid="([^"]*)"/;
const MARKER_PREFIX = 'bfid:';

// The id inside a `bfid:<id>` marker comment, or null if `text` isn't one.
function markerId(text: string): string | null {
	return text.startsWith(MARKER_PREFIX) ? text.slice(MARKER_PREFIX.length) : null;
}

/**
 * Bracket `node` with a `bfid:` marker comment pair as immediate siblings within
 * its container array, and return the pair's ids. Used to mark a patchable child
 * range (a `{{ print }}` or a whole `b-if` set) so the browser runtime can locate
 * and replace what's between the markers.
 *
 * Idempotent: if `node` is already flanked by a marker pair, its ids are returned
 * without touching the tree. This is what keeps `applyDomPatch` safe to run more
 * than once on the same AST — the preview does, once to render the HTML and once
 * to emit the JS. Without it a second run would splice in a new inner pair and the
 * JS would key off markers the server-rendered HTML never had. `ensureBfid` gives
 * the same guarantee for `data-bfid` attributes.
 */
export function ensureCommentsAround(
	container: TNode[],
	node: TNode,
	gen: BfidGen,
): { startId: string; endId: string } {
	const idx = container.indexOf(node);
	if (idx === -1) throw new Error('dom-patch: node not found in its container for comment insertion');
	const prev = container[idx - 1];
	const next = container[idx + 1];
	if (prev?.type === 'comment' && next?.type === 'comment') {
		const startId = markerId(prev.text);
		const endId = markerId(next.text);
		if (startId !== null && endId !== null) return { startId, endId };
	}
	const startId = gen();
	const endId = gen();
	container.splice(idx, 0, { type: 'comment', text: commentMarker(startId) });
	// `node` is now at idx+1; the closing marker goes right after it, at idx+2.
	container.splice(idx + 2, 0, { type: 'comment', text: commentMarker(endId) });
	return { startId, endId };
}

// Reuse an existing `data-bfid` static attr in `attrs`, or append one. Idempotent,
// which is what keeps `applyDomPatch` safe to run twice on the same AST.
function ensureBfidInAttrs(attrs: AttrPart[], bfidGen: BfidGen): string {
	for (const a of attrs) {
		if (a.type === 'static') {
			const m = a.raw.match(BFID_RE);
			if (m) return m[1];
		}
	}
	const id = bfidGen();
	attrs.push({ type: 'static', raw: ` data-bfid="${id}"` });
	return id;
}

export function ensureBfid(element: ElementTNode, bfidGen: BfidGen): string {
	return ensureBfidInAttrs(element.attrs, bfidGen);
}

// Stamp a `data-bfid` onto a nested custom-element call's rendered tag by adding it
// to `callerAttrs` (merged into the open tag at render time). Idempotent, and shared
// across every dynamic caller attr on the same call so they resolve to one element.
export function ensureCallBfid(call: CustomElementCallTNode, bfidGen: BfidGen): string {
	call.callerAttrs ??= [];
	return ensureBfidInAttrs(call.callerAttrs, bfidGen);
}

/**
 * Return the site's **anchor element**: the nearest enclosing element whose DOM
 * node the site patches (an attr's element, a print's / if-set's parent element),
 * or null when that is the custom element itself. Codegen compares this against
 * the owning patch-branch's ref element to decide `this.ref_elem` vs `sel_<bfid>`.
 */
export function elementForSite(s: Site): ElementTNode | null {
	// An if-set anchors to the nearest enclosing element, or null (this.ref_elem).
	if (isIfSetSite(s)) return s.parentElement;
	switch (s.site.kind) {
		case 'attr': return s.site.element;
		case 'print': return s.site.parentElement;
		case 'definition-root-attr': return null;
		case 'caller-attr-expr':
			// Its anchor is a custom-element call node, not an ElementTNode; toBfidSite
			// stamps it via ensureCallBfid instead of routing through here.
			throw new Error("dom-patch: 'caller-attr-expr' target is resolved in toBfidSite, not elementForSite");
		case 'for-iterable':
		case 'binding':
			throw new Error("not implemented: "+s.site.kind);
	}
}
