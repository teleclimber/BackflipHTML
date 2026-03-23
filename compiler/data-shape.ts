import type { RootTNode, TNode, ForTNode, IfTNode, PrintTNode, AttrBindTNode, PartialRefTNode } from './compiler.js';

/**
 * Infer the free variables used in a partial's TNode tree.
 * Free variables are those referenced in expressions but not locally
 * scoped (e.g., not introduced by b-for loop variables).
 */
export function inferFreeVars(root: RootTNode): string[] {
	const freeVars = new Set<string>();
	walkNodes(root.tnodes, new Set(), freeVars);
	return [...freeVars].sort();
}

function collectFree(vars: string[], scoped: Set<string>, freeVars: Set<string>): void {
	for (const v of vars) {
		if (!scoped.has(v)) {
			freeVars.add(v);
		}
	}
}

function walkNodes(tnodes: TNode[], scoped: Set<string>, freeVars: Set<string>): void {
	for (const node of tnodes) {
		switch (node.type) {
			case 'print': {
				const n = node as PrintTNode;
				collectFree(n.data.vars, scoped, freeVars);
				break;
			}
			case 'for': {
				const n = node as ForTNode;
				// The iterable expression is in the current scope
				collectFree(n.iterable.vars, scoped, freeVars);
				// The loop variable is scoped for children
				const childScope = new Set(scoped);
				childScope.add(n.valName);
				walkNodes(n.tnodes, childScope, freeVars);
				break;
			}
			case 'if': {
				const n = node as IfTNode;
				for (const branch of n.branches) {
					if (branch.condition) {
						collectFree(branch.condition.vars, scoped, freeVars);
					}
					walkNodes(branch.tnodes, scoped, freeVars);
				}
				break;
			}
			case 'attr-bind': {
				const n = node as AttrBindTNode;
				for (const part of n.parts) {
					if (part.type === 'dynamic') {
						collectFree(part.expr.vars, scoped, freeVars);
					}
				}
				break;
			}
			case 'partial-ref': {
				const n = node as PartialRefTNode;
				for (const binding of n.bindings) {
					collectFree(binding.data.vars, scoped, freeVars);
				}
				// Slot content is evaluated in the caller's scope,
				// so walk slot contents too
				for (const slotNodes of Object.values(n.slots)) {
					walkNodes(slotNodes as TNode[], scoped, freeVars);
				}
				break;
			}
			// 'raw' and 'slot' nodes have no expressions
			default:
				break;
		}
	}
}
