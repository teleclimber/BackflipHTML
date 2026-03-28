import { collectSlots } from '@backflip/html';
import type { CompiledDirectory, CompiledFile, RootTNode, TNode, PartialRefTNode, ForTNode, IfTNode, SlotTNode, SourceLoc, DataShape } from '@backflip/html';

export interface PartialDef {
	file: string;
	name: string;
	loc?: SourceLoc;
	exported: boolean;
	slots: string[];
	freeVars: string[];
	dataShape?: Map<string, DataShape>;
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
				exported: root.exported ?? false,
				slots,
				freeVars: root.freeVars ?? [],
				dataShape: root.dataShape,
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

function collectRefs(tnodes: TNode[], filePath: string, refs: PartialRef[]): void {
	for (const tnode of tnodes) {
		switch (tnode.type) {
			case 'partial-ref': {
				const ref = tnode as PartialRefTNode;
				refs.push({
					file: filePath,
					partialName: ref.partialName,
					targetFile: ref.file,
					loc: ref.loc,
					dataBindings: ref.bindings.map(b => b.name),
					slotsFilled: Object.keys(ref.slots),
				});
				// Also walk slot contents
				for (const slotNodes of Object.values(ref.slots)) {
					collectRefs(slotNodes as TNode[], filePath, refs);
				}
				break;
			}
			case 'for': {
				const forNode = tnode as ForTNode;
				collectRefs(forNode.tnodes, filePath, refs);
				break;
			}
			case 'if': {
				const ifNode = tnode as IfTNode;
				for (const branch of ifNode.branches) {
					collectRefs(branch.tnodes, filePath, refs);
				}
				break;
			}
			default:
				break;
		}
	}
}

