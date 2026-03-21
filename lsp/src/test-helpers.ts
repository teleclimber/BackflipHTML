import type { ProjectIndex, PartialDef, PartialRef } from './index.js';
import type { SourceLoc } from '@backflip/html';

export function makeLoc(startLine: number, startCol: number, endLine: number, endCol: number): SourceLoc {
	return { startLine, startCol, startOffset: 0, endLine, endCol, endOffset: 0 };
}

export function makeIndex(defs: PartialDef[], refs: PartialRef[]): ProjectIndex {
	const partialDefs = new Map<string, PartialDef[]>();
	for (const def of defs) {
		const existing = partialDefs.get(def.name);
		if (existing) existing.push(def);
		else partialDefs.set(def.name, [def]);
	}
	return { partialDefs, partialRefs: refs };
}
