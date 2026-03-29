import type { SlotMap, RawRNode } from '../runtime/js/render.js';
import type { TNode, RawTNode, SlotTNode, ForTNode, IfTNode, AttrBindTNode } from '../compiler/compiler.js';

const PLACEHOLDER_STYLE = 'background:#e0e0e0;padding:16px;border:1px dashed #999;border-radius:4px;text-align:center;color:#666;font-style:italic;';

function placeholderNode(label: string): RawRNode {
	return {
		type: 'raw',
		raw: `<div style="${PLACEHOLDER_STYLE}">${label}</div>`,
	};
}

/**
 * Generate a SlotMap with placeholder content for each declared slot.
 * Used when previewing a partial in isolation (no real caller to fill slots).
 * Slots inside <head> get empty content (divs are not valid in <head>).
 */
export function generateSlotPlaceholders(tnodes: TNode[]): SlotMap {
	const headSlots = new Set<string>();
	findHeadSlots(tnodes, false, headSlots);

	const slotMap: SlotMap = {};
	walkSlots(tnodes, (name) => {
		if (headSlots.has(name)) {
			slotMap[name] = { nodes: [], ctx: {} };
		} else {
			const label = name === 'default' ? 'default content' : `slot: ${name}`;
			slotMap[name] = { nodes: [placeholderNode(label)], ctx: {} };
		}
	});
	return slotMap;
}

/** Walk tnodes and call fn for each slot found. */
function walkSlots(tnodes: TNode[], fn: (name: string) => void): void {
	for (const tnode of tnodes) {
		if (tnode.type === 'slot') {
			fn((tnode as SlotTNode).name ?? 'default');
		} else if (tnode.type === 'for') {
			walkSlots((tnode as ForTNode).tnodes, fn);
		} else if (tnode.type === 'if') {
			for (const branch of (tnode as IfTNode).branches) {
				walkSlots(branch.tnodes, fn);
			}
		}
	}
}

/**
 * Walk tnodes tracking whether we are inside a <head> element.
 * Detects <head> opens/closes in both RawTNode.raw and AttrBindTNode.tagOpen.
 */
function findHeadSlots(tnodes: TNode[], inHead: boolean, out: Set<string>): boolean {
	for (const tnode of tnodes) {
		if (tnode.type === 'raw') {
			inHead = updateHeadState((tnode as RawTNode).raw, inHead);
		} else if (tnode.type === 'attr-bind') {
			inHead = updateHeadState((tnode as AttrBindTNode).tagOpen, inHead);
		} else if (tnode.type === 'slot') {
			if (inHead) out.add((tnode as SlotTNode).name ?? 'default');
		} else if (tnode.type === 'for') {
			inHead = findHeadSlots((tnode as ForTNode).tnodes, inHead, out);
		} else if (tnode.type === 'if') {
			for (const branch of (tnode as IfTNode).branches) {
				inHead = findHeadSlots(branch.tnodes, inHead, out);
			}
		}
	}
	return inHead;
}

/** Update inHead state based on raw HTML content. */
function updateHeadState(raw: string, inHead: boolean): boolean {
	if (/<head[\s>]|<head$/i.test(raw)) inHead = true;
	if (/<\/head>/i.test(raw)) inHead = false;
	return inHead;
}
