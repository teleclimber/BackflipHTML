import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert';
import { SymbolKind } from 'vscode-languageserver';
import { getDocumentSymbols } from './symbols.js';
import { makeLoc, makeIndex } from './test-helpers.js';

describe('getDocumentSymbols', () => {
	it('returns symbols for the correct file only', () => {
		const index = makeIndex(
			[
				{ file: 'page.html', name: 'header', loc: makeLoc(1, 1, 1, 20), exported: false },
				{ file: 'page.html', name: 'footer', loc: makeLoc(5, 1, 5, 20), exported: false },
				{ file: 'other.html', name: 'sidebar', loc: makeLoc(1, 1, 1, 15), exported: false },
			],
			[],
		);
		const result = getDocumentSymbols('page.html', index);
		strictEqual(result.length, 2);
		const names = result.map(s => s.name).sort();
		deepStrictEqual(names, ['footer', 'header']);
	});

	it('returns empty array for unknown file', () => {
		const index = makeIndex(
			[{ file: 'page.html', name: 'header', loc: makeLoc(1, 1, 1, 20), exported: false }],
			[],
		);
		const result = getDocumentSymbols('nonexistent.html', index);
		deepStrictEqual(result, []);
	});

	it('symbols have correct kind and range', () => {
		const index = makeIndex(
			[{ file: 'page.html', name: 'card', loc: makeLoc(3, 5, 3, 25), exported: false }],
			[],
		);
		const result = getDocumentSymbols('page.html', index);
		strictEqual(result.length, 1);
		strictEqual(result[0].kind, SymbolKind.Function);
		deepStrictEqual(result[0].range, {
			start: { line: 2, character: 4 },
			end: { line: 2, character: 24 },
		});
	});
});
