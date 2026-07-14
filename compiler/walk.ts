import type { TNode } from './types.js';

/**
 * Shared TNode tree-traversal utilities. The compiler recurses over the same
 * 9-way TNode variant set in several places; these two functions capture the
 * two shapes of that recursion (in-place visit and copy-transform) so a new
 * TNode field is handled in exactly one spot.
 *
 * Child containers of a TNode are:
 *   - for.tnodes
 *   - if.branches[i].tnodes
 *   - element.tnodes
 *   - partial-ref slots[slotName]  (slot content lives in the caller's tree)
 * raw / comment / print / slot / attr-bind are leaves.
 */

export interface VisitTNodesOptions {
	/**
	 * Skip partial-ref slot contents. Slot content declared inside a slot passed
	 * to a child partial belongs to that child's call, not to the current tree, so
	 * some walkers (e.g. collectSlots) must not descend through it.
	 */
	skipPartialRefSlots?: boolean;
}

/**
 * Depth-first pre-order traversal. Calls `visit` on every node in `tnodes`,
 * then recurses into each node's child containers. `IfBranch` is not a TNode,
 * so `visit` is not called on branches themselves — only their `tnodes` are
 * traversed.
 */
export function visitTNodes(tnodes: TNode[], visit: (n: TNode) => void, opts?: VisitTNodesOptions): void {
	for (const n of tnodes) {
		visit(n);
		switch (n.type) {
			case 'for':
				visitTNodes(n.tnodes, visit, opts);
				break;
			case 'if':
				for (const branch of n.branches) visitTNodes(branch.tnodes, visit, opts);
				break;
			case 'element':
				visitTNodes(n.tnodes, visit, opts);
				break;
			case 'partial-ref':
				if (!opts?.skipPartialRefSlots) {
					for (const slotNodes of Object.values(n.slots)) visitTNodes(slotNodes, visit, opts);
				}
				break;
			// raw / comment / print / slot / attr-bind: leaves
		}
	}
}

export interface MapTNodesOptions {
	/** Merge adjacent RawTNodes in every produced list (matches resolveTNodes' behavior). */
	coalesceRaws?: boolean;
}

/**
 * Structural copy-transform. Rebuilds the tree bottom-up: child containers
 * (for.tnodes, if.branches, element.tnodes, partial-ref slots) are mapped first,
 * then `fn` is applied to a shallow spread-copy of the node whose containers have
 * been replaced. `fn` may return the node as-is or a replacement (1:1 only).
 * Because copies are made with object spread, fields unknown to this utility
 * survive by default — this is the point: no more field-by-field copy code that
 * silently drops new fields.
 *
 * The input tree is not mutated. Parsed expression objects (`data`, `condition`,
 * `iterable`, AttrPart `expr`) are shared by reference, matching resolveTNodes today.
 */
export function mapTNodes(tnodes: TNode[], fn: (n: TNode) => TNode, opts?: MapTNodesOptions): TNode[] {
	const result: TNode[] = [];
	for (const node of tnodes) {
		let copy: TNode;
		switch (node.type) {
			case 'for':
				copy = { ...node, tnodes: mapTNodes(node.tnodes, fn, opts) };
				break;
			case 'if':
				copy = { ...node, branches: node.branches.map(b => ({ ...b, tnodes: mapTNodes(b.tnodes, fn, opts) })) };
				break;
			case 'element':
				copy = { ...node, tnodes: mapTNodes(node.tnodes, fn, opts) };
				break;
			case 'partial-ref': {
				const slots: { [slotName: string]: TNode[] } = {};
				for (const [slotName, slotTnodes] of Object.entries(node.slots)) {
					slots[slotName] = mapTNodes(slotTnodes, fn, opts);
				}
				copy = { ...node, slots };
				break;
			}
			default:
				copy = { ...node };
		}
		const mapped = fn(copy);
		if (opts?.coalesceRaws) appendCoalesced(result, mapped);
		else result.push(mapped);
	}
	return result;
}

/**
 * Append `node` to `arr`, merging into the trailing RawTNode when both are raw.
 * The single implementation of the "coalesce adjacent raws" rule (previously
 * re-implemented several times across the compiler).
 */
export function appendCoalesced(arr: TNode[], node: TNode): void {
	const prev = arr[arr.length - 1];
	if (node.type === 'raw' && prev && prev.type === 'raw') {
		prev.raw += node.raw;
	} else {
		arr.push(node);
	}
}
