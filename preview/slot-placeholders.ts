import type { SlotMap, RawRNode } from '../runtime/js/render.js';
import type { TNode, RawTNode, SlotTNode, ForTNode, IfTNode, ElementTNode } from '../compiler/types.js';
import { collectSlots } from '../compiler/helpers.js';

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
	for (const name of collectSlots(tnodes)) {
		if (headSlots.has(name)) {
			slotMap[name] = { nodes: [], ctx: {} };
		} else {
			const label = name === 'default' ? 'default content' : `slot: ${name}`;
			slotMap[name] = { nodes: [placeholderNode(label)], ctx: {} };
		}
	}
	return slotMap;
}

/**
 * Walk tnodes tracking whether we are inside a <head> element.
 * Recognizes ElementTNode whose tagName is 'head' as well as legacy raw HTML
 * with <head>/</head> markers (still possible inside imported / pre-rendered content).
 */
function findHeadSlots(tnodes: TNode[], inHead: boolean, out: Set<string>): boolean {
	for (const tnode of tnodes) {
		if (tnode.type === 'raw') {
			inHead = updateHeadState((tnode as RawTNode).raw, inHead);
		} else if (tnode.type === 'element') {
			const el = tnode as ElementTNode;
			const isHead = el.tagName === 'head';
			inHead = findHeadSlots(el.tnodes, inHead || isHead, out);
			if (isHead) inHead = false;
		} else if (tnode.type === 'slot') {
			if (inHead) out.add((tnode as SlotTNode).name ?? 'default');
		} else if (tnode.type === 'for') {
			inHead = findHeadSlots((tnode as ForTNode).tnodes, inHead, out);
		} else if (tnode.type === 'if') {
			for (const branch of (tnode as IfTNode).branches) {
				inHead = findHeadSlots(branch.tnodes, inHead, out);
			}
		} else if (tnode.type === 'partial-ref') {
			// A b-slot written inside a call body is a slot of *this* partial
			// (slot forwarding), so it counts here too.
			for (const slotNodes of Object.values(tnode.slots)) {
				inHead = findHeadSlots(slotNodes, inHead, out);
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
