import type { ProjectIndex, PartialDef, PartialRef } from './index.js';
import { partialKey } from '@backflip/html';
import type { SourceLoc, DataShape } from '@backflip/html';
import type { TextDocument } from 'vscode-languageserver-textdocument';

export function makeLoc(startLine: number, startCol: number, endLine: number, endCol: number): SourceLoc {
	return { startLine, startCol, startOffset: 0, endLine, endCol, endOffset: 0 };
}

export type PartialDefInput = Omit<PartialDef, 'slots' | 'freeVars' | 'dataShape' | 'customElement' | 'bAttrs'> & { slots?: string[]; freeVars?: string[]; dataShape?: Map<string, DataShape>; customElement?: boolean; bAttrs?: { name: string; isBool: boolean }[] };
export type PartialRefInput = Omit<PartialRef, 'fromPartial' | 'target' | 'dataBindings' | 'slotsFilled'> & { fromPartial?: string; target?: string | null; dataBindings?: string[]; slotsFilled?: string[] };

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
		fromPartial: r.fromPartial ?? '',
		// A call names a file or resolves within the one it is written in.
		target: r.target !== undefined ? r.target : partialKey(r.targetFile ?? r.file, r.partialName),
		dataBindings: r.dataBindings ?? [],
		slotsFilled: r.slotsFilled ?? [],
	}));
	return { partialDefs, partialRefs };
}

/** A fake TextDocument from lines of text. Honours character offsets within each line. */
export function makeDoc(lines: string[]): TextDocument {
	const text = lines.join('\n');
	const lineStarts: number[] = [0];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '\n') lineStarts.push(i + 1);
	}
	const offsetAt = (p: { line: number; character: number }): number => {
		if (p.line >= lineStarts.length) return text.length;
		if (p.line < 0) return 0;
		const lineStart = lineStarts[p.line];
		const lineEnd = p.line + 1 < lineStarts.length ? lineStarts[p.line + 1] - 1 : text.length;
		return Math.min(lineStart + Math.max(0, p.character), lineEnd);
	};
	return {
		getText(range?: any): string {
			if (!range) return text;
			return text.substring(offsetAt(range.start), offsetAt(range.end));
		},
		offsetAt,
	} as TextDocument;
}
