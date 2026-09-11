import type {
	CompiledFile, RootTNode, TNode, SourceLoc,
	ElementTNode, PartialRefTNode, CustomElementCallTNode,
} from '@backflip/html';

/**
 * One thing in a template that a cursor can be on, with the span it occupies.
 *
 * Every span here comes from the compiler, so it is the extent of the thing as
 * authored — not a guess made by matching the text of one line. That is what
 * lets two of the same directive sit on one line, or one directive straddle a
 * line break, without the answer changing.
 */
export type Target =
	| { kind: 'element'; loc: SourceLoc; partialName: string; node: ElementTNode }
	| { kind: 'b-name'; loc: SourceLoc; partialName: string; root: RootTNode }
	| { kind: 'custom-element-def'; loc: SourceLoc; partialName: string; root: RootTNode }
	| { kind: 'b-attr'; loc: SourceLoc; partialName: string; attrName: string; isBool: boolean }
	| { kind: 'b-part'; loc: SourceLoc; partialName: string; node: PartialRefTNode }
	| { kind: 'custom-element'; loc: SourceLoc; partialName: string; node: CustomElementCallTNode }
	| { kind: 'caller-attr'; loc: SourceLoc; partialName: string; attrName: string; node: CustomElementCallTNode }
	| { kind: 'b-in'; loc: SourceLoc; partialName: string; slotName: string; node: PartialRefTNode }
	| { kind: 'b-data'; loc: SourceLoc; partialName: string; bindingName: string; node: PartialRefTNode }
	| { kind: 'b-slot'; loc: SourceLoc; partialName: string; slotName: string | undefined }
	| { kind: 'print'; loc: SourceLoc; partialName: string }
	| {
		kind: 'asset-ref'; loc: SourceLoc; partialName: string;
		assetName: string; subpath: string; attrName: string;
		/** Span of just the subpath, when the compiler recorded one. */
		subpathLoc?: SourceLoc;
	};

/**
 * Everything at `offset`, innermost first.
 *
 * "Innermost" is by span width, so a `b-part` attribute comes before the
 * element carrying it, which comes before that element's ancestors. Touching
 * siblings never both match: spans are half-open, so the offset where one ends
 * is the first offset of the next.
 *
 * `offset` is a 0-based character index into the file, matching
 * `SourceLoc.startOffset`; `TextDocument.offsetAt` produces one.
 *
 * Only what the compiler kept is here. Content outside every partial
 * definition never reaches a compiled tree, so it resolves to nothing — as do
 * raw text runs, which carry no location at all.
 */
export function resolveAt(file: CompiledFile, offset: number): Target[] {
	const found: Target[] = [];
	for (const [partialName, root] of file.partials) {
		collectRoot(root, partialName, offset, found);
	}
	found.sort((a, b) => {
		const widthA = a.loc.endOffset - a.loc.startOffset;
		const widthB = b.loc.endOffset - b.loc.startOffset;
		if (widthA !== widthB) return widthA - widthB;
		return b.loc.startOffset - a.loc.startOffset;
	});
	return found;
}

/** The innermost element at `offset`, or null when the offset is on none. */
export function elementAt(file: CompiledFile, offset: number): ElementTNode | null {
	for (const target of resolveAt(file, offset)) {
		if (target.kind === 'element') return target.node;
	}
	return null;
}

/** The first target of one of `kinds` at `offset` — the innermost such thing. */
export function targetAt<K extends Target['kind']>(
	file: CompiledFile, offset: number, ...kinds: K[]
): Extract<Target, { kind: K }> | null {
	for (const target of resolveAt(file, offset)) {
		if ((kinds as string[]).includes(target.kind)) return target as Extract<Target, { kind: K }>;
	}
	return null;
}

/**
 * Half-open, `[startOffset, endOffset)`, because `SourceLoc.endOffset` points
 * directly after the last character. An offset identifies the character at it,
 * so the position where `</span>` ends is the `<` of the next tag and belongs
 * to that tag alone — treating the end as inclusive makes touching siblings
 * both claim it.
 */
function contains(loc: SourceLoc | undefined, offset: number): loc is SourceLoc {
	return loc !== undefined && offset >= loc.startOffset && offset < loc.endOffset;
}

function collectRoot(root: RootTNode, partialName: string, offset: number, out: Target[]): void {
	if (contains(root.loc, offset)) {
		out.push(root.kind === 'custom-element'
			? { kind: 'custom-element-def', loc: root.loc, partialName, root }
			: { kind: 'b-name', loc: root.loc, partialName, root });
	}
	if (root.kind === 'custom-element') {
		for (const attr of root.bAttrs ?? []) {
			if (contains(attr.loc, offset)) {
				out.push({ kind: 'b-attr', loc: attr.loc, partialName, attrName: attr.name, isBool: attr.isBool });
			}
		}
		collectAttrs(root.definitionAttrs ?? [], partialName, offset, out);
	}
	collect(root.tnodes, partialName, offset, out);
}

function collect(tnodes: TNode[], partialName: string, offset: number, out: Target[]): void {
	for (const node of tnodes) {
		switch (node.type) {
			case 'element':
				// The element's full extent, open tag through close, so the cursor
				// resolves to the element it is inside and not merely to its tag.
				if (contains(node.loc, offset)) {
					out.push({ kind: 'element', loc: node.loc, partialName, node });
				}
				collectAttrs(node.attrs, partialName, offset, out);
				collect(node.tnodes, partialName, offset, out);
				break;

			case 'partial-ref':
				collectPartialRef(node, partialName, offset, out);
				break;

			case 'slot':
				if (contains(node.loc, offset)) {
					out.push({ kind: 'b-slot', loc: node.loc, partialName, slotName: node.name });
				}
				break;

			case 'print':
				if (contains(node.loc, offset)) {
					out.push({ kind: 'print', loc: node.loc, partialName });
				}
				break;

			case 'for':
				// No target of its own: a `for` carries the b-for *value's* span,
				// which sits inside the looped element's open tag rather than
				// wrapping it, so treating it as a container would place the
				// cursor in the wrong thing.
				collect(node.tnodes, partialName, offset, out);
				break;

			case 'if':
				for (const branch of node.branches) collect(branch.tnodes, partialName, offset, out);
				break;

			case 'attr-bind':
				collectAttrs(node.attrs, partialName, offset, out);
				break;
		}
	}
}

function collectPartialRef(node: PartialRefTNode, partialName: string, offset: number, out: Target[]): void {
	if (contains(node.loc, offset)) {
		out.push(node.kind === 'custom-element'
			? { kind: 'custom-element', loc: node.loc, partialName, node }
			: { kind: 'b-part', loc: node.loc, partialName, node });
	}

	// `b-in` sits on the element filling the slot, but only the call knows which
	// slot that is — so it is reported from here rather than found by scanning
	// upward from the element.
	for (const [slotName, loc] of Object.entries(node.slotLocs ?? {})) {
		if (contains(loc, offset)) {
			out.push({ kind: 'b-in', loc, partialName, slotName, node });
		}
	}

	for (const binding of node.bindings) {
		if (contains(binding.nameLoc, offset)) {
			out.push({ kind: 'b-data', loc: binding.nameLoc, partialName, bindingName: binding.name, node });
		}
	}

	if (node.kind === 'custom-element') {
		for (const attr of node.callerAttrInfos ?? []) {
			if (contains(attr.loc, offset)) {
				out.push({ kind: 'caller-attr', loc: attr.loc, partialName, attrName: attr.name, node });
			}
		}
		collectAttrs(node.callerAttrs ?? [], partialName, offset, out);
	}

	for (const slotTNodes of Object.values(node.slots)) {
		collect(slotTNodes, partialName, offset, out);
	}
}

function collectAttrs(
	attrs: ElementTNode['attrs'], partialName: string, offset: number, out: Target[],
): void {
	for (const part of attrs) {
		if (part.type !== 'asset') continue;
		for (const ref of part.refs) {
			if (contains(ref.loc, offset)) {
				const target: Extract<Target, { kind: 'asset-ref' }> = {
					kind: 'asset-ref', loc: ref.loc, partialName,
					assetName: ref.name, subpath: ref.subpath, attrName: part.attrName,
				};
				if (ref.subpathLoc) target.subpathLoc = ref.subpathLoc;
				out.push(target);
			}
		}
	}
}
