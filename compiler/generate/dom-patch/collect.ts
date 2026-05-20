import type {
	TNode, ElementTNode, ForTNode, IfBranch, PrintTNode,
	PartialRefTNode, CustomElementCallTNode, BPartCallTNode,
	PartialBinding, AttrPart, CustomElementPartialRoot,
} from '../../types.js';
import type { Parsed } from '../../backcode.js';

export type BackcodeSiteKind =
	| { kind: 'attr'; element: ElementTNode; attr: AttrPart & { type: 'dynamic' } }
	| { kind: 'definition-root-attr'; attr: AttrPart & { type: 'dynamic' } }
	| { kind: 'print'; node: PrintTNode }
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
	walkList(root.tnodes, liveVarNames, false, out);
	return out;
}

function walkList(
	tnodes: TNode[],
	liveVarNames: Set<string>,
	inForLoop: boolean,
	out: BackcodeSite[],
): void {
	for (const n of tnodes) walkNode(n, liveVarNames, inForLoop, out);
}

function walkNode(
	n: TNode,
	liveVarNames: Set<string>,
	inForLoop: boolean,
	out: BackcodeSite[],
): void {
	switch (n.type) {
		case 'raw':
		case 'slot':
		case 'attr-bind':
			return;
		case 'print': {
			pushSite(out, { kind: 'print', node: n }, n.data, liveVarNames, inForLoop);
			return;
		}
		case 'for': {
			pushSite(out, { kind: 'for-iterable', node: n }, n.iterable, liveVarNames, inForLoop);
			walkList(n.tnodes, liveVarNames, true, out);
			return;
		}
		case 'if': {
			for (const b of n.branches) {
				if (b.condition) pushSite(out, { kind: 'if-condition', branch: b }, b.condition, liveVarNames, inForLoop);
				walkList(b.tnodes, liveVarNames, inForLoop, out);
			}
			return;
		}
		case 'element': {
			for (const a of n.attrs) {
				if (a.type === 'dynamic') {
					pushSite(out, { kind: 'attr', element: n, attr: a }, a.expr, liveVarNames, inForLoop);
				}
			}
			walkList(n.tnodes, liveVarNames, inForLoop, out);
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
