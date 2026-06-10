import type {
	TNode, RootTNode, ElementTNode, ForTNode, IfTNode, IfBranch,
	PartialRefTNode, CompiledFile,
} from './types.js';

/**
 * Walk a tree and compress ElementTNodes into raw chunks where possible. The
 * result is a tree where ElementTNodes only remain when they wrap non-leaf
 * children (for/if/print/slot/partial-ref/nested element).
 *
 * Decomposition rules for an element whose children, after recursion, are all
 * leaf-flat (raw / attr-bind):
 *
 *   - all-static attrs → raw('<tag staticAttrs>') + kids + raw('</tag>')
 *   - has dynamic attrs → raw('<tag') + attr-bind(attrs) + raw('>'|' />') + kids + raw('</tag>')
 *
 * Either way, the surrounding raws merge with the parent's static structure,
 * so a dynamic attribute deep in a subtree no longer blocks every ancestor
 * from collapsing — only the attr-bind itself remains.
 *
 * Elements with unresolved `asset` AttrParts are not decomposed — asset parts
 * are replaced with static parts by `resolveAssetRefs` (called downstream of
 * `compileDirectory` in cli.ts / preview.ts). If you call flattenStatics after
 * asset resolution, asset-bearing elements decompose like any other.
 *
 * Returns a new tree; input is not mutated. Idempotent: a second run produces
 * a deep-equal result.
 */
export function flattenStatics(root: RootTNode): RootTNode {
	return { ...root, tnodes: flattenList(root.tnodes) };
}

/**
 * Apply `flattenStatics` to every partial in a CompiledFile, returning a new
 * CompiledFile. The input is not mutated.
 */
export function flattenCompiledFile(file: CompiledFile): CompiledFile {
	const partials = new Map<string, RootTNode>();
	for (const [name, root] of file.partials) {
		partials.set(name, flattenStatics(root));
	}
	return { partials };
}

function flattenList(tnodes: TNode[]): TNode[] {
	const out: TNode[] = [];
	for (const n of tnodes) {
		for (const flat of flattenNode(n)) {
			const prev = out[out.length - 1];
			if (flat.type === 'raw' && prev && prev.type === 'raw') {
				out[out.length - 1] = { type: 'raw', raw: prev.raw + flat.raw };
			} else {
				out.push(flat);
			}
		}
	}
	return out;
}

function flattenNode(n: TNode): TNode[] {
	switch (n.type) {
		case 'raw':
		case 'comment':
		case 'print':
		case 'slot':
		case 'attr-bind':
			return [n];
		case 'for': {
			const f = n as ForTNode;
			return [{ ...f, tnodes: flattenList(f.tnodes) }];
		}
		case 'if': {
			const i = n as IfTNode;
			const branches: IfBranch[] = i.branches.map(b => ({ ...b, tnodes: flattenList(b.tnodes) }));
			return [{ ...i, branches }];
		}
		case 'partial-ref': {
			const p = n as PartialRefTNode;
			const slots: { [slotName: string]: TNode[] } = {};
			for (const [k, arr] of Object.entries(p.slots)) slots[k] = flattenList(arr);
			return [{ ...p, slots }];
		}
		case 'element':
			return flattenElement(n as ElementTNode);
	}
}

function flattenElement(el: ElementTNode): TNode[] {
	const flatChildren = flattenList(el.tnodes);
	const childrenLeafFlat = flatChildren.every(c => c.type === 'raw' || c.type === 'comment' || c.type === 'attr-bind');
	// Unresolved asset attrs must stay on an ElementTNode — codegen would throw
	// otherwise. After resolveAssetRefs runs, asset parts have been turned into
	// static parts and this branch is no longer taken.
	const hasAsset = el.attrs.some(p => p.type === 'asset');
	if (!childrenLeafFlat || hasAsset) {
		return [{ ...el, tnodes: flatChildren }];
	}
	const hasDynamic = el.attrs.some(p => p.type === 'dynamic');
	const openCloser = el.selfClosing ? ' />' : '>';
	const parts: TNode[] = [];
	if (!hasDynamic) {
		let openTag = `<${el.tagName}`;
		for (const p of el.attrs) {
			if (p.type === 'static') openTag += p.raw;
		}
		openTag += openCloser;
		parts.push({ type: 'raw', raw: openTag });
	} else {
		parts.push({ type: 'raw', raw: `<${el.tagName}` });
		parts.push({ type: 'attr-bind', attrs: el.attrs, loc: el.openTagLoc });
		parts.push({ type: 'raw', raw: openCloser });
	}
	for (const c of flatChildren) parts.push(c);
	if (!el.isVoid && !el.selfClosing) {
		parts.push({ type: 'raw', raw: `</${el.tagName}>` });
	}
	return parts;
}
