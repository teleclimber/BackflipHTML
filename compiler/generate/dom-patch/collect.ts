import type {
	TNode, ElementTNode, ForTNode, IfTNode, PrintTNode,
	PartialRefTNode, CustomElementCallTNode, BPartCallTNode,
	PartialBinding, AttrPart, CustomElementPartialRoot,
} from '../../types.js';
import type { Parsed } from '../../backcode.js';

export type BackcodeSiteKind =
	| { kind: 'attr'; element: ElementTNode; attr: AttrPart & { type: 'dynamic' } }
	| { kind: 'definition-root-attr'; attr: AttrPart & { type: 'dynamic' } }
	// `container` is the tnodes array the print lives in (so markers can be spliced
	// in as siblings). `parentElement` is the nearest enclosing element — the DOM
	// node the markers become children of — or null when that is the custom element
	// root itself (b-if/b-for wrappers don't introduce a DOM element, so they are
	// transparent here).
	| { kind: 'print'; node: PrintTNode; container: TNode[]; parentElement: ElementTNode | null }
	| { kind: 'for-iterable'; node: ForTNode }
	| { kind: 'binding'; ref: CustomElementCallTNode | BPartCallTNode; binding: PartialBinding & { kind: 'expr' } }
	// A `b-bind:`/`:` dynamic attribute on a *nested* custom-element call. The call
	// renders as a real element, so the attribute is patched with `setAttribute` on
	// it (located by a `data-bfid` stamped into the call's `callerAttrs`), which the
	// nested custom element then observes. `ref` is stamped; `attr` drives codegen.
	| { kind: 'caller-attr-expr'; ref: CustomElementCallTNode; attr: AttrPart & { type: 'dynamic' } };

export interface BackcodeSite {
	site: BackcodeSiteKind;
	parsed: Parsed;
	liveVars: string[];
	otherVars: string[];
	inForLoop: boolean;
}

/**
 * A whole `b-if` / `b-else-if` / `b-else` set, tracked as one patch site.
 *
 * Unlike a `BackcodeSite` it has *N* expressions (one per conditional branch),
 * so it can't carry a single `parsed`. `liveVars`/`otherVars` are the union
 * across the set's **own** branch conditions only — expressions nested inside
 * the branches never trigger the set (see the dom-patch README).
 *
 * Anchoring mirrors a print site: `container` is the TNode[] the `IfTNode` lives
 * in (where the marker comments get spliced) and `parentElement` is the nearest
 * enclosing element, or null when that is the custom element itself.
 */
export interface IfSetSite {
	kind: 'if-set';
	node: IfTNode;
	container: TNode[];
	parentElement: ElementTNode | null;
	liveVars: string[];
	otherVars: string[];
	inForLoop: boolean;
}

export type Site = BackcodeSite | IfSetSite;

export function isIfSetSite(s: Site): s is IfSetSite {
	return 'kind' in s;
}

/**
 * One patch-branch's worth of the AST, before any bfid/marker is allocated.
 *
 * A `BranchScope` owns the sites and sets that are reachable from its root
 * without crossing into a nested **qualifying** `b-if` — each of those becomes
 * an `IfSetScope` whose branches are fresh child scopes. A non-qualifying set is
 * inert client-side, so its content is walked inline into the enclosing scope.
 */
export interface BranchScope {
	/**
	 * Nearest enclosing element of this scope's root — the element the generated
	 * class receives as `ref_elem`. `null` means the custom element itself.
	 */
	refElement: ElementTNode | null;
	/** Qualifying sites anchored in this scope, outside every nested qualifying set. */
	sites: BackcodeSite[];
	/** Qualifying b-if sets this scope owns. */
	sets: IfSetScope[];
}

export interface IfSetScope {
	set: IfSetSite;
	/** Index-aligned with `set.node.branches`. */
	branches: BranchScope[];
}

/**
 * Walk a custom-element partial into a tree of patch-branch scopes, keeping only
 * qualifying sites and partitioning at every qualifying `b-if` set. The `qualifies`
 * predicate is injected (rather than imported) so this module takes no dependency
 * on `filter.ts`; callers wire it as `s => qualifies(s, liveVarNames)`.
 *
 * Replaces the old flat `collectBackcodeSites`: because the tree's *shape* depends
 * on which sets qualify, the filter can no longer run downstream.
 */
export function collectPatchTree(
	root: CustomElementPartialRoot,
	liveVarNames: Set<string>,
	qualifies: (s: Site) => boolean,
): BranchScope {
	const scope: BranchScope = { refElement: null, sites: [], sets: [] };
	// Dynamic attrs on the definition's wrapping tag (rendered on the custom element itself).
	if (root.definitionAttrs) {
		for (const a of root.definitionAttrs) {
			if (a.type === 'dynamic') {
				const site = makeBackcodeSite({ kind: 'definition-root-attr', attr: a }, a.expr, liveVarNames, false);
				if (qualifies(site)) scope.sites.push(site);
			}
		}
	}
	walkList(root.tnodes, liveVarNames, false, scope, null, qualifies);
	return scope;
}

function walkList(
	tnodes: TNode[],
	liveVarNames: Set<string>,
	inForLoop: boolean,
	scope: BranchScope,
	parentElement: ElementTNode | null,
	qualifies: (s: Site) => boolean,
): void {
	for (const n of tnodes) walkNode(n, liveVarNames, inForLoop, scope, parentElement, tnodes, qualifies);
}

function walkNode(
	n: TNode,
	liveVarNames: Set<string>,
	inForLoop: boolean,
	scope: BranchScope,
	parentElement: ElementTNode | null,
	container: TNode[],
	qualifies: (s: Site) => boolean,
): void {
	switch (n.type) {
		case 'raw':
		case 'comment':
		case 'slot':
		case 'attr-bind':
			return;
		case 'print': {
			const site = makeBackcodeSite({ kind: 'print', node: n, container, parentElement }, n.data, liveVarNames, inForLoop);
			if (qualifies(site)) scope.sites.push(site);
			return;
		}
		case 'for': {
			// A for-iterable never qualifies, and every site inside the loop is
			// `inForLoop` (also non-qualifying). b-for/b-if don't create a DOM element,
			// so the nearest enclosing element for descendants is unchanged.
			walkList(n.tnodes, liveVarNames, true, scope, parentElement, qualifies);
			return;
		}
		case 'if': {
			const set = makeIfSetSite(n, container, parentElement, liveVarNames, inForLoop);
			if (qualifies(set)) {
				// A qualifying set is a patch-branch boundary: each branch becomes a fresh
				// child scope whose ref element is the set's nearest enclosing element —
				// exactly what renderIf_ resolves and hands the child as `ref_elem`.
				const branches = n.branches.map(b => {
					const child: BranchScope = { refElement: parentElement, sites: [], sets: [] };
					walkList(b.tnodes, liveVarNames, inForLoop, child, parentElement, qualifies);
					return child;
				});
				scope.sets.push({ set, branches });
			} else {
				// Inert client-side: its content sites stay owned by the enclosing scope.
				for (const b of n.branches) {
					walkList(b.tnodes, liveVarNames, inForLoop, scope, parentElement, qualifies);
				}
			}
			return;
		}
		case 'element': {
			for (const a of n.attrs) {
				if (a.type === 'dynamic') {
					const site = makeBackcodeSite({ kind: 'attr', element: n, attr: a }, a.expr, liveVarNames, inForLoop);
					if (qualifies(site)) scope.sites.push(site);
				}
			}
			walkList(n.tnodes, liveVarNames, inForLoop, scope, n, qualifies);
			return;
		}
		case 'partial-ref':
			// A custom-element call renders as a real element, so a dynamic caller attr
			// driven by live vars is a patchable attribute site on it (the nested element
			// observes the change). A b-part call inlines its partial with no stable
			// element, b-data: bindings aren't patchable, and slot contents live in the
			// caller's scope — none of those contribute to a patch-branch.
			if (n.kind === 'custom-element' && n.callerAttrs) {
				for (const a of n.callerAttrs) {
					if (a.type !== 'dynamic') continue;
					const site = makeBackcodeSite({ kind: 'caller-attr-expr', ref: n, attr: a }, a.expr, liveVarNames, inForLoop);
					if (qualifies(site)) scope.sites.push(site);
				}
			}
			return;
	}
}

// Build the site record for a whole if-set. Its trigger vars are the union of the
// vars in its own branch conditions (a `b-else` has none).
function makeIfSetSite(
	node: IfTNode,
	container: TNode[],
	parentElement: ElementTNode | null,
	liveVarNames: Set<string>,
	inForLoop: boolean,
): IfSetSite {
	const liveVars: string[] = [];
	const otherVars: string[] = [];
	for (const b of node.branches) {
		if (!b.condition) continue;
		for (const v of b.condition.vars) {
			const bucket = liveVarNames.has(v) ? liveVars : otherVars;
			if (!bucket.includes(v)) bucket.push(v);
		}
	}
	return { kind: 'if-set', node, container, parentElement, liveVars, otherVars, inForLoop };
}

function makeBackcodeSite(
	site: BackcodeSiteKind,
	parsed: Parsed,
	liveVarNames: Set<string>,
	inForLoop: boolean,
): BackcodeSite {
	const liveVars: string[] = [];
	const otherVars: string[] = [];
	for (const v of parsed.vars) {
		if (liveVarNames.has(v)) liveVars.push(v);
		else otherVars.push(v);
	}
	return { site, parsed, liveVars, otherVars, inForLoop };
}
