import type { AttrPart, TNode } from '../../types.js';
import type { Parsed } from '../../backcode.js';
import { isIfSetSite, type IfSetSite, type Site } from './collect.js';

/**
 * Predicate: true when a site should drive dom-patch codegen.
 *
 * Every variable a qualifying partial can name is one of its declared inputs —
 * the compiler rejects a partial that generates client JS and reads anything else —
 * so there is no live/non-live split to test here. What remains are the rules about
 * *where* a site sits and what its subtree contains.
 */
export function qualifies(s: Site): boolean {
	// Cross-kind rules:
	if (s.liveVars.length === 0) return false;   // nothing to drive a patch
	if (s.inForLoop) return false;
	if (isIfSetSite(s)) return ifSetQualifies(s);
	// Per-kind support (extend as new kinds become patchable):
	switch (s.site.kind) {
		case 'attr':
		case 'definition-root-attr':
		case 'print':
			return true;
		case 'caller-attr-expr':
			// An asset-bearing expression can't be patched client-side (no asset map).
			return !s.site.attr.isAsset;
		case 'for-iterable':
		case 'binding':
			return false;
	}
}

/**
 * If-set rules beyond the cross-kind ones (see the dom-patch README):
 *  - every conditional branch parses and names at least one variable,
 *  - the whole subtree is renderable client-side — no partial refs, no slots,
 *    no asset references.
 *
 * Nesting is allowed: a qualifying set may sit inside another. The whole-subtree
 * check below still runs for every set, so a disqualifier anywhere (including in a
 * nested set) sinks the enclosing set too. A failure disqualifies the set silently.
 */
function ifSetQualifies(s: IfSetSite): boolean {
	for (const b of s.node.branches) {
		if (!b.condition) continue;   // b-else: no expression to check
		if (!exprOk(b.condition)) return false;
		if (b.condition.vars.length === 0) return false;
	}
	// The whole subtree must be renderable client-side.
	for (const b of s.node.branches) {
		if (!subtreeOk(b.tnodes)) return false;
	}
	return true;
}

// An expression is usable when it parsed. Its variables need no check: they are
// the partial's declared inputs, which collectData() hands the browser.
function exprOk(parsed: Parsed): boolean {
	return !!parsed.expr;
}

// Matches an unresolved "@name/..." asset reference inside a static attr's raw text.
const ASSET_REF_RE = /@[A-Za-z0-9_-]+\//;

function attrsOk(attrs: AttrPart[]): boolean {
	for (const a of attrs) {
		// Asset parts (unresolved) and asset-bearing expressions can't be rendered
		// client-side — the browser has no asset map.
		if (a.type === 'asset') return false;
		if (a.type === 'static') {
			if (ASSET_REF_RE.test(a.raw)) return false;
			continue;
		}
		if (a.isAsset) return false;
		if (!exprOk(a.expr)) return false;
	}
	return true;
}

function subtreeOk(tnodes: TNode[]): boolean {
	for (const n of tnodes) {
		switch (n.type) {
			case 'raw':
			case 'comment':
				break;
			case 'slot':
			case 'partial-ref':
				// Rendering these client-side would need the caller's scope / the
				// referenced partial's tree, neither of which the snapshot carries.
				return false;
			case 'print':
				if (!exprOk(n.data)) return false;
				break;
			case 'attr-bind':
				if (!attrsOk(n.attrs)) return false;
				break;
			case 'element':
				if (!attrsOk(n.attrs)) return false;
				if (!subtreeOk(n.tnodes)) return false;
				break;
			case 'for':
				if (!exprOk(n.iterable)) return false;
				if (!subtreeOk(n.tnodes)) return false;
				break;
			case 'if':
				for (const b of n.branches) {
					if (b.condition && !exprOk(b.condition)) return false;
					if (!subtreeOk(b.tnodes)) return false;
				}
				break;
		}
	}
	return true;
}
