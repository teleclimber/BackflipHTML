import { DocumentSymbol, SymbolKind } from 'vscode-languageserver';
import type { ProjectIndex } from './index.js';

/**
 * Return DocumentSymbols for partials defined in the given file.
 */
export function getDocumentSymbols(
	filePath: string,
	index: ProjectIndex,
): DocumentSymbol[] {
	const symbols: DocumentSymbol[] = [];

	for (const [name, defs] of index.partialDefs) {
		for (const def of defs) {
			if (def.file !== filePath) continue;
			if (!def.loc) continue;

			const range = {
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
				range,
				selectionRange: range,
			});
		}
	}

	return symbols;
}
