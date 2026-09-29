/// <reference lib="dom" />
// Browser-side helpers imported by generated dom-patch modules.

/**
 * Replace everything between two marker comments among `parent`'s direct children
 * with `node`. The markers themselves survive, so the range stays patchable.
 */
export function replaceBetween(parent: Node, startMarker: string, endMarker: string, node: Node): void {
	let start: ChildNode | null = null, end: ChildNode | null = null;
	for (const child of parent.childNodes) {
		if (child.nodeType !== 8) continue;
		if (child.nodeValue === startMarker) start = child;
		else if (child.nodeValue === endMarker) end = child;
	}
	if (!start || !end) {
		console.error(`BackflipHTML: comment markers ${startMarker} / ${endMarker} not found; skipping update`, parent);
		return;
	}
	let n = start.nextSibling;
	while (n && n !== end) {
		const next = n.nextSibling;
		parent.removeChild(n);
		n = next;
	}
	parent.insertBefore(node, end);
}
