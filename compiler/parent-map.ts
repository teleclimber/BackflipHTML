import type { TNode, RootTNode, ParentTNode } from './types.js';

export type ParentMap = WeakMap<TNode, ParentTNode>;

/**
 * Build a WeakMap from every TNode in the tree to its immediate parent container
 * (the RootTNode, ForTNode, IfBranch, or ElementTNode that holds it in a tnodes/branches array).
 *
 * The root itself is not in the map (it has no TNode parent). Slot content inside
 * a PartialRefTNode is mapped to *the partial-ref's parent*, matching how slot
 * content is evaluated in the caller's scope.
 *
 * Cost: O(N) walk of the tree, called once per consumer. The returned map is
 * a WeakMap so it can be discarded; the tree itself stays acyclic and serializable.
 */
export function computeParentMap(root: RootTNode): ParentMap {
	const map: ParentMap = new WeakMap();
	function walkContainer(container: ParentTNode, tnodes: TNode[]) {
		for (const n of tnodes) {
			map.set(n, container);
			if (n.type === 'for') walkContainer(n, n.tnodes);
			else if (n.type === 'if') {
				for (const branch of n.branches) walkContainer(branch, branch.tnodes);
			}
			else if (n.type === 'element') walkContainer(n, n.tnodes);
			else if (n.type === 'partial-ref') {
				for (const slotNodes of Object.values(n.slots)) {
					// Slot content lives in the caller's scope — parent of slot tnodes is
					// the partial-ref's parent (`container`), not the partial-ref itself.
					// *Note:* This may not be corect for CSS evaluation or anything that depends 
					// on fully rendered view as opposed to authoring view.
					walkContainer(container, slotNodes);
				}
			}
		}
	}
	walkContainer(root, root.tnodes);
	return map;
}
