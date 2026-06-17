import type {
	TNode, ElementTNode, ForTNode, IfBranch, PrintTNode,
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
	| { kind: 'if-condition'; branch: IfBranch }
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

export function collectBackcodeSites(
	root: CustomElementPartialRoot,
	liveVarNames: Set<string>,
): BackcodeSite[] {
	const out: BackcodeSite[] = [];
	// Dynamic attrs on the definition's wrapping tag (rendered on the custom element itself).
	if (root.definitionAttrs) {
		for (const a of root.definitionAttrs) {
			if (a.type === 'dynamic') {
				pushSite(out, { kind: 'definition-root-attr', attr: a }, a.expr, liveVarNames, false);
			}
		}
	}
	walkList(root.tnodes, liveVarNames, false, out, null);// q: why is this not the actual custom element??
	return out;
}

function walkList(
	tnodes: TNode[],
	liveVarNames: Set<string>,
	inForLoop: boolean,
	out: BackcodeSite[],
	parentElement: ElementTNode | null,
): void {
	for (const n of tnodes) walkNode(n, liveVarNames, inForLoop, out, parentElement, tnodes);
}

function walkNode(
	n: TNode,
	liveVarNames: Set<string>,
	inForLoop: boolean,
	out: BackcodeSite[],
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
			walkList(n.tnodes, liveVarNames, true, out, parentElement);
			return;
		}
		case 'if': {
			for (const b of n.branches) {
				if (b.condition) pushSite(out, { kind: 'if-condition', branch: b }, b.condition, liveVarNames, inForLoop);
				walkList(b.tnodes, liveVarNames, inForLoop, out, parentElement);
			}
			return;
		}
		case 'element': {
			for (const a of n.attrs) {
				if (a.type === 'dynamic') {
					pushSite(out, { kind: 'attr', element: n, attr: a }, a.expr, liveVarNames, inForLoop);
				}
			}
			walkList(n.tnodes, liveVarNames, inForLoop, out, n);
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

function pushSite(
	out: BackcodeSite[],
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
