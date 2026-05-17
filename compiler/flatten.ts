import type {
	TNode, RootTNode, ElementTNode, RawTNode, ForTNode, IfTNode, IfBranch,
	PartialRefTNode, CompiledFile,
} from './types.js';

/**
 * Walk a tree and collapse fully-static ElementTNode subtrees into a single
 * RawTNode containing the pre-rendered HTML. Returns a new tree (pure — input
 * is not mutated).
 *
 * An element is "fully static" when all of its attrs are `static` AttrParts
 * AND all of its children (after recursion) are RawTNodes. Such a subtree
 * compiles down to a sequence of raw-string emissions at codegen anyway, so
 * folding it ahead of time produces fewer runtime iterations without changing
 * the rendered output.
 *
 * Elements with unresolved `asset` AttrParts are not flattenable — asset parts
 * are replaced with static parts by `resolveAssetRefs` (called downstream of
 * `compileDirectory` in cli.ts / preview.ts). If you call flattenStatics after
 * asset resolution, asset-bearing elements become flattenable too.
 *
 * Idempotent: running it twice produces a deep-equal result.
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
		const flat = flattenNode(n);
		const prev = out[out.length - 1];
		if (flat.type === 'raw' && prev && prev.type === 'raw') {
			out[out.length - 1] = { type: 'raw', raw: (prev as RawTNode).raw + flat.raw };
		} else {
			out.push(flat);
		}
	}
	return out;
}

function flattenNode(n: TNode): TNode {
	switch (n.type) {
		case 'raw':
		case 'print':
		case 'slot':
			return n;
		case 'for': {
			const f = n as ForTNode;
			return { ...f, tnodes: flattenList(f.tnodes) };
		}
		case 'if': {
			const i = n as IfTNode;
			const branches: IfBranch[] = i.branches.map(b => ({ ...b, tnodes: flattenList(b.tnodes) }));
			return { ...i, branches };
		}
		case 'partial-ref': {
			const p = n as PartialRefTNode;
			const slots: { [slotName: string]: TNode[] } = {};
			for (const [k, arr] of Object.entries(p.slots)) slots[k] = flattenList(arr);
			return { ...p, slots };
		}
		case 'element': {
			const el = n as ElementTNode;
			const childTnodes = flattenList(el.tnodes);
			if (isFullyStaticElement(el, childTnodes)) {
				return { type: 'raw', raw: renderStaticElement(el, childTnodes) };
			}
			return { ...el, tnodes: childTnodes };
		}
	}
}

function isFullyStaticElement(el: ElementTNode, flatTnodes: TNode[]): boolean {
	for (const part of el.attrs) {
		if (part.type !== 'static') return false;
	}
	for (const child of flatTnodes) {
		if (child.type !== 'raw') return false;
	}
	return true;
}

function renderStaticElement(el: ElementTNode, flatTnodes: TNode[]): string {
	let out = `<${el.tagName}`;
	for (const part of el.attrs) {
		if (part.type === 'static') out += part.raw;
	}
	out += el.selfClosing ? ' />' : '>';
	for (const child of flatTnodes) {
		out += (child as RawTNode).raw;
	}
	if (!el.isVoid && !el.selfClosing) {
		out += `</${el.tagName}>`;
	}
	return out;
}
