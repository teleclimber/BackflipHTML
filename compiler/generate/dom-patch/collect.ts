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
	| { kind: 'caller-attr-expr'; ref: CustomElementCallTNode; attrInfo: NonNullable<CustomElementCallTNode['callerAttrInfos']>[number] };

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
	/** True when this set is nested inside another if-set (disqualifying — v1). */
	inIfSet: boolean;
}

export type Site = BackcodeSite | IfSetSite;

export function isIfSetSite(s: Site): s is IfSetSite {
	return 'kind' in s;
}

export function collectBackcodeSites(
	root: CustomElementPartialRoot,
	liveVarNames: Set<string>,
): Site[] {
	const out: Site[] = [];
	// Dynamic attrs on the definition's wrapping tag (rendered on the custom element itself).
	if (root.definitionAttrs) {
		for (const a of root.definitionAttrs) {
			if (a.type === 'dynamic') {
				pushSite(out, { kind: 'definition-root-attr', attr: a }, a.expr, liveVarNames, false);
			}
		}
	}
	walkList(root.tnodes, liveVarNames, false, false, out, null);// q: why is this not the actual custom element??
	return out;
}

function walkList(
	tnodes: TNode[],
	liveVarNames: Set<string>,
	inForLoop: boolean,
	inIfSet: boolean,
	out: Site[],
	parentElement: ElementTNode | null,
): void {
	for (const n of tnodes) walkNode(n, liveVarNames, inForLoop, inIfSet, out, parentElement, tnodes);
}

function walkNode(
	n: TNode,
	liveVarNames: Set<string>,
	inForLoop: boolean,
	inIfSet: boolean,
	out: Site[],
	parentElement: ElementTNode | null,
	container: TNode[],
): void {
	switch (n.type) {
		case 'raw':
		case 'comment':
		case 'slot':
		case 'attr-bind':
			return;
		case 'print': {
			pushSite(out, { kind: 'print', node: n, container, parentElement }, n.data, liveVarNames, inForLoop);
			return;
		}
		case 'for': {
			pushSite(out, { kind: 'for-iterable', node: n }, n.iterable, liveVarNames, inForLoop);
			// b-for/b-if don't create a DOM element, so the nearest enclosing element
			// for descendants is unchanged.
			walkList(n.tnodes, liveVarNames, true, inIfSet, out, parentElement);
			return;
		}
		case 'if': {
			out.push(makeIfSetSite(n, container, parentElement, liveVarNames, inForLoop, inIfSet));
			// Branch bodies are still walked: attr and print sites inside a branch are
			// collected exactly as before (they are their own patch sites). Descendant
			// if-sets are marked nested so the filter can reject them.
			for (const b of n.branches) {
				walkList(b.tnodes, liveVarNames, inForLoop, true, out, parentElement);
			}
			return;
		}
		case 'element': {
			for (const a of n.attrs) {
				if (a.type === 'dynamic') {
					pushSite(out, { kind: 'attr', element: n, attr: a }, a.expr, liveVarNames, inForLoop);
				}
			}
			walkList(n.tnodes, liveVarNames, inForLoop, inIfSet, out, n);
			return;
		}
		case 'partial-ref': {
			for (const b of n.bindings) {
				if (b.kind === 'expr') {
					pushSite(out, { kind: 'binding', ref: n, binding: b }, b.data, liveVarNames, inForLoop);
				}
			}
			if (n.kind === 'custom-element' && n.callerAttrInfos) {
				for (const info of n.callerAttrInfos) {
					if (info.kind === 'expr' && info.expr) {
						pushSite(out, { kind: 'caller-attr-expr', ref: n, attrInfo: info }, info.expr, liveVarNames, inForLoop);
					}
				}
			}
			// Per spec: do NOT recurse into slots[...] — slot contents live in caller scope.
			return;
		}
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
	inIfSet: boolean,
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
	return { kind: 'if-set', node, container, parentElement, liveVars, otherVars, inForLoop, inIfSet };
}

function pushSite(
	out: Site[],
	site: BackcodeSiteKind,
	parsed: Parsed,
	liveVarNames: Set<string>,
	inForLoop: boolean,
): void {
	const liveVars: string[] = [];
	const otherVars: string[] = [];
	for (const v of parsed.vars) {
		if (liveVarNames.has(v)) liveVars.push(v);
		else otherVars.push(v);
	}
	out.push({ site, parsed, liveVars, otherVars, inForLoop });
}
