import { DocumentSymbol, SymbolKind } from 'vscode-languageserver';
import type { Range } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { ProjectIndex, PartialDef } from './index.js';

/**
 * Return DocumentSymbols for partials defined in the given file.
 *
 * `range` covers the whole definition and `selectionRange` just its name, as
 * the protocol asks. The full range is what makes the outline and breadcrumbs
 * track the cursor anywhere inside a partial, and what lets a client ask which
 * partial a position falls in. Deriving it needs `doc`, because the compiler
 * reports the extent as offsets; without a document — or without an extent —
 * both ranges fall back to the name span, which is the behaviour clients saw
 * before the extent was indexed.
 */
export function getDocumentSymbols(
	filePath: string,
	index: ProjectIndex,
	doc?: TextDocument,
): DocumentSymbol[] {
	const symbols: DocumentSymbol[] = [];

	for (const [name, defs] of index.partialDefs) {
		for (const def of defs) {
			if (def.file !== filePath) continue;
			if (!def.loc) continue;

			const selectionRange = {
				start: {
					line: def.loc.startLine - 1,
					character: def.loc.startCol - 1,
				},
				end: {
					line: def.loc.endLine - 1,
					character: def.loc.endCol - 1,
				},
			};

			symbols.push({
				name,
				kind: SymbolKind.Function,
				range: fullRange(def, selectionRange, doc),
				selectionRange,
			});
		}
	}

	return symbols;
}

/**
 * The definition's whole span, or `selectionRange` when it cannot be trusted.
 *
 * The index and the open document can disagree — the index is from the last
 * compile, the document is what the editor holds now — so an extent that no
 * longer contains the name span is stale or degenerate. Publishing it would
 * break the protocol's requirement that `selectionRange` sit inside `range`,
 * and clients place the cursor using it, so prefer the narrower truth.
 */
function fullRange(def: PartialDef, selectionRange: Range, doc?: TextDocument): Range {
	if (!doc || !def.extent) return selectionRange;
	const range = {
		start: doc.positionAt(def.extent.startOffset),
		end: doc.positionAt(def.extent.endOffset),
	};
	return contains(range, selectionRange) ? range : selectionRange;
}

function contains(outer: Range, inner: Range): boolean {
	return !isBefore(inner.start, outer.start) && !isBefore(outer.end, inner.end);
}

function isBefore(a: { line: number; character: number }, b: { line: number; character: number }): boolean {
	return a.line !== b.line ? a.line < b.line : a.character < b.character;
}
