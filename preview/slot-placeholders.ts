import type { SlotMap, RawRNode } from '../runtime/js/render.js';

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
 */
export function generateSlotPlaceholders(slotNames: string[]): SlotMap {
	const slotMap: SlotMap = {};
	for (const name of slotNames) {
		const label = name === 'default' ? 'default content' : `slot: ${name}`;
		slotMap[name] = { nodes: [placeholderNode(label)], ctx: {} };
	}
	return slotMap;
}
