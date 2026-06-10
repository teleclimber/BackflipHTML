import type { ElementTNode, TNode } from '../../types.js';
import type { BfidGen } from './bfid.js';
import type { BackcodeSite } from './collect.js';

const BFID_RE = /\sdata-bfid="([^"]*)"/;

/**
 * Insert two comment nodes as immediate siblings bracketing `node` within its
 * container array — `beforeText` just before it, `afterText` just after. Used to
 * mark a patchable child range (e.g. a `{{ print }}`) so the browser runtime can
 * locate and replace what's between the markers. Generic on purpose: `b-if` /
 * `b-for` ranges will reuse it.
 */
export function insertCommentsAround(
	container: TNode[],
	node: TNode,
	beforeText: string,
	afterText: string,
): void {
	const idx = container.indexOf(node);
	if (idx === -1) throw new Error('dom-patch: node not found in its container for comment insertion');
	container.splice(idx, 0, { type: 'comment', text: beforeText });
	// `node` is now at idx+1; the closing marker goes right after it, at idx+2.
	container.splice(idx + 2, 0, { type: 'comment', text: afterText });
}

export function ensureBfid(element: ElementTNode, bfidGen: BfidGen): string {
	for (const a of element.attrs) {
		if (a.type === 'static') {
			const m = a.raw.match(BFID_RE);
			if (m) return m[1];
		}
	}
	const id = bfidGen();
	element.attrs.push({ type: 'static', raw: ` data-bfid="${id}"` });
	return id;
}

/**
 * Return the element to which a `data-bfid` should be attached for this site,
 * or null if the kind doesn't anchor to a bfid-tagged element (e.g. it targets
 * the custom element itself, where the runtime already has a direct reference).
 * Extend the switch as new kinds become patchable.
 */
export function elementForSite(s: BackcodeSite): ElementTNode | null {
	switch (s.site.kind) {
		case 'attr': return s.site.element;
		case 'definition-root-attr': return null;
		case 'print':
		case 'if-condition':
		case 'for-iterable':
		case 'binding':
		case 'caller-attr-expr':
			throw new Error("not implemented: "+s.site.kind);
	}
}
