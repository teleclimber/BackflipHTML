import type { ProjectIndex, PartialDef, PartialRef } from './index.js';
import type { SourceLoc, DataShape } from '@backflip/html';

export function makeLoc(startLine: number, startCol: number, endLine: number, endCol: number): SourceLoc {
	return { startLine, startCol, startOffset: 0, endLine, endCol, endOffset: 0 };
}

export type PartialDefInput = Omit<PartialDef, 'slots' | 'freeVars' | 'dataShape' | 'customElement' | 'bAttrs'> & { slots?: string[]; freeVars?: string[]; dataShape?: Map<string, DataShape>; customElement?: boolean; bAttrs?: { name: string; isBool: boolean }[] };
export type PartialRefInput = Omit<PartialRef, 'dataBindings' | 'slotsFilled'> & { dataBindings?: string[]; slotsFilled?: string[] };

export function makeIndex(defs: PartialDefInput[], refs: PartialRefInput[]): ProjectIndex {
	const partialDefs = new Map<string, PartialDef[]>();
	for (const d of defs) {
		const def: PartialDef = { ...d, slots: d.slots ?? [], freeVars: d.freeVars ?? [], dataShape: d.dataShape, customElement: d.customElement ?? false, bAttrs: d.bAttrs };
		const existing = partialDefs.get(def.name);
		if (existing) existing.push(def);
		else partialDefs.set(def.name, [def]);
	}
	const partialRefs: PartialRef[] = refs.map(r => ({
		...r,
		dataBindings: r.dataBindings ?? [],
		slotsFilled: r.slotsFilled ?? [],
	}));
	return { partialDefs, partialRefs };
}
