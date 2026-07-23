import type { AttrPart, TNode } from '../../types.js';
import type { Parsed } from '../../backcode.js';
import { isIfSetSite, type IfSetSite, type Site } from './collect.js';

/**
 * Predicate: true when a site should drive dom-patch codegen.
 *
 * `liveVarNames` is the partial's full live-var set; if-sets need it to check
 * expressions deep in their subtree (a `BackcodeSite` already carries the split
 * as `liveVars`/`otherVars`). Use as `sites.filter(s => qualifies(s, liveVars))`
 * — never bare `filter(qualifies)`, which would pass the array index as the set.
 */
export function qualifies(s: Site, liveVarNames: Set<string>): boolean {
	// Cross-kind rules:
	if (s.liveVars.length === 0) return false;
	if (s.otherVars.length > 0) return false;
	if (s.inForLoop) return false;
	if (isIfSetSite(s)) return ifSetQualifies(s, liveVarNames);
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
 *  - the whole subtree is renderable client-side from live vars alone —
 *    no non-live vars, no partial refs, no slots, no asset references.
 *
 * Nesting is allowed: a qualifying set may sit inside another. The whole-subtree
 * check below still runs for every set, so a disqualifier anywhere (including in a
 * nested set) sinks the enclosing set too. A failure disqualifies the set silently.
 */
function ifSetQualifies(s: IfSetSite, liveVarNames: Set<string>): boolean {
	for (const b of s.node.branches) {
		if (!b.condition) continue;   // b-else: no expression to check
		if (!exprOk(b.condition, liveVarNames, new Set())) return false;
		if (b.condition.vars.length === 0) return false;
	}
	// The whole subtree must be renderable from live vars alone.
	for (const b of s.node.branches) {
		if (!subtreeOk(b.tnodes, liveVarNames, new Set())) return false;
	}
	return true;
}

// An expression is usable when it parsed and every variable it names is either a
// live var or locally bound by an enclosing b-for.
function exprOk(parsed: Parsed, liveVarNames: Set<string>, scope: Set<string>): boolean {
	if (!parsed.expr) return false;
	return parsed.vars.every(v => liveVarNames.has(v) || scope.has(v));
}

// Matches an unresolved "@name/..." asset reference inside a static attr's raw text.
const ASSET_REF_RE = /@[A-Za-z0-9_-]+\//;

function attrsOk(attrs: AttrPart[], liveVarNames: Set<string>, scope: Set<string>): boolean {
	for (const a of attrs) {
		// Asset parts (unresolved) and asset-bearing expressions can't be rendered
		// client-side — the browser has no asset map.
		if (a.type === 'asset') return false;
		if (a.type === 'static') {
			if (ASSET_REF_RE.test(a.raw)) return false;
			continue;
		}
		if (a.isAsset) return false;
		if (!exprOk(a.expr, liveVarNames, scope)) return false;
	}
	return true;
}

function subtreeOk(tnodes: TNode[], liveVarNames: Set<string>, scope: Set<string>): boolean {
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
				if (!exprOk(n.data, liveVarNames, scope)) return false;
				break;
			case 'attr-bind':
				if (!attrsOk(n.attrs, liveVarNames, scope)) return false;
				break;
			case 'element':
				if (!attrsOk(n.attrs, liveVarNames, scope)) return false;
				if (!subtreeOk(n.tnodes, liveVarNames, scope)) return false;
				break;
			case 'for': {
				if (!exprOk(n.iterable, liveVarNames, scope)) return false;
				// The value name is bound for the loop body only, so it is exempt
				// from the live-var check there (`item` and `item.x` alike).
				const inner = new Set(scope);
				inner.add(n.valName);
				if (!subtreeOk(n.tnodes, liveVarNames, inner)) return false;
				break;
			}
			case 'if':
				for (const b of n.branches) {
					if (b.condition && !exprOk(b.condition, liveVarNames, scope)) return false;
					if (!subtreeOk(b.tnodes, liveVarNames, scope)) return false;
				}
				break;
		}
	}
	return true;
}
