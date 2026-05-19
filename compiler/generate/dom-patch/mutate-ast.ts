import type { ElementTNode } from '../../types.js';
import type { BfidGen } from './bfid.js';
import type { BackcodeSite } from './collect.js';

const BFID_RE = /\sdata-bfid="([^"]*)"/;

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
 * or null if the kind doesn't anchor to a single element (or isn't supported yet).
 * Extend the switch as new kinds become patchable.
 */
export function elementForSite(s: BackcodeSite): ElementTNode | null {
	switch (s.site.kind) {
		case 'attr': return s.site.element;
		case 'print':
		case 'if-condition':
		case 'for-iterable':
		case 'binding':
		case 'caller-attr-expr':
			throw new Error("not implemented: "+s.site.kind);
	}
}
