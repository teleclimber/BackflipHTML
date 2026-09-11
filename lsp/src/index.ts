import { collectSlots, inferDataShape, inferFreeVars, visitPartialRefs } from '@backflip/html';
import type { CompiledDirectory, RootTNode, TNode, SourceLoc, DataShape } from '@backflip/html';

export interface PartialDef {
	file: string;
	name: string;
	/**
	 * The definition's *name* span: the `b-name="..."` attribute for a named
	 * partial, the whole open tag for a custom element one. Not the definition's
	 * extent — see `extent`.
	 */
	loc?: SourceLoc;
	/**
	 * The definition's full extent, opening `<` through the end of the closing
	 * tag, as 0-based file offsets (end exclusive). Offsets rather than
	 * line/col because that is all `PartialMeta` carries; convert with
	 * `TextDocument.positionAt`.
	 *
	 * Absent when the compiler never resolved the extent — an unclosed
	 * definition leaves `meta.endOffset` at its start.
	 */
	extent?: { startOffset: number; endOffset: number };
	exported: boolean;
	slots: string[];
	freeVars: string[];
	dataShape?: Map<string, DataShape>;
	customElement: boolean;
	bAttrs?: { name: string; isBool: boolean }[];
}

export interface PartialRef {
	file: string;
	partialName: string;
	targetFile: string | null; // null = same-file
	loc?: SourceLoc;
	dataBindings: string[];
	slotsFilled: string[];
}

export interface ProjectIndex {
	partialDefs: Map<string, PartialDef[]>; // key: partial name
	partialRefs: PartialRef[];
}

export function buildIndex(directory: CompiledDirectory): ProjectIndex {
	const partialDefs = new Map<string, PartialDef[]>();
	const partialRefs: PartialRef[] = [];

	for (const [filePath, compiledFile] of directory.files) {
		for (const [name, root] of compiledFile.partials) {
			const slots = collectSlots(root.tnodes);
			const def: PartialDef = {
				file: filePath,
				name,
				loc: root.loc,
				extent: partialExtent(root),
				exported: root.exported ?? false,
				slots,
				freeVars: inferFreeVars(root),
				dataShape: inferDataShape(root),
				customElement: root.kind === 'custom-element',
				bAttrs: root.kind === 'custom-element' ? root.bAttrs?.map(a => ({ name: a.name, isBool: a.isBool })) : undefined,
			};
			const existing = partialDefs.get(name);
			if (existing) {
				existing.push(def);
			} else {
				partialDefs.set(name, [def]);
			}

			collectRefs(root.tnodes, filePath, partialRefs);
		}
	}

	return { partialDefs, partialRefs };
}

/**
 * The definition's extent from its `PartialMeta`, or undefined when the
 * compiler could not determine one. `lowerNamedDefinition` seeds `endOffset`
 * at `startOffset` and only overwrites it once the closing tag is found, so a
 * non-advancing end means "unknown" rather than "empty".
 */
function partialExtent(root: RootTNode): { startOffset: number; endOffset: number } | undefined {
	const meta = root.meta;
	if (!meta || meta.endOffset <= meta.startOffset) return undefined;
	return { startOffset: meta.startOffset, endOffset: meta.endOffset };
}

/**
 * Record every `b-part` / custom-element call under `tnodes` as a PartialRef.
 *
 * The traversal is the compiler's `visitPartialRefs`, the same one codegen and
 * `link.ts` use, so the references the editor counts are the ones the generated
 * output resolves.
 */
function collectRefs(tnodes: TNode[], filePath: string, refs: PartialRef[]): void {
	visitPartialRefs(tnodes, (ref) => {
		refs.push({
			file: filePath,
			partialName: ref.partialName,
			targetFile: ref.file,
			loc: ref.loc,
			dataBindings: ref.bindings.map(b => b.name),
			slotsFilled: Object.keys(ref.slots),
		});
	});
}
