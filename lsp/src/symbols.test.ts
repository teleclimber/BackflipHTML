import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert';
import { SymbolKind } from 'vscode-languageserver';
import { getDocumentSymbols } from './symbols.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
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

describe('getDocumentSymbols — full partial extent', () => {
	// `range` must cover the whole definition so the outline/breadcrumbs track the
	// cursor anywhere inside a partial, and so the extension's "which partial is
	// the cursor in?" check (Preview Partial) works off any line, not just the
	// definition line. `selectionRange` stays on the name.
	function docOf(content: string) {
		return TextDocument.create('file:///page.html', 'html', 1, content);
	}

	const NAMED = [
		'<div b-name="page">',   // line 1, offsets 0..19
		'  <p>one</p>',          // line 2
		'</div>',                // line 3, ends at offset 39
	].join('\n');

	const CUSTOM = [
		'<my-widget b-attr:label>',  // line 1, offsets 0..24
		'  <b>{{ label }}</b>',      // line 2
		'</my-widget>',              // line 3, ends at offset 58
	].join('\n');

	it('covers the whole named partial, selecting the b-name attribute', () => {
		const index = makeIndex(
			[{
				file: 'page.html', name: 'page', exported: false,
				loc: makeLoc(1, 6, 1, 19),          // b-name="page"
				extent: { startOffset: 0, endOffset: 39 },
			}],
			[],
		);
		const result = getDocumentSymbols('page.html', index, docOf(NAMED));
		strictEqual(result.length, 1);
		deepStrictEqual(result[0].range, {
			start: { line: 0, character: 0 },
			end: { line: 2, character: 6 },
		});
		deepStrictEqual(result[0].selectionRange, {
			start: { line: 0, character: 5 },
			end: { line: 0, character: 18 },
		});
	});

	it('covers the whole custom-element partial, selecting the open tag', () => {
		const index = makeIndex(
			[{
				file: 'page.html', name: 'my-widget', exported: false, customElement: true,
				loc: makeLoc(1, 1, 1, 25),          // the whole open tag
				extent: { startOffset: 0, endOffset: 58 },
			}],
			[],
		);
		const result = getDocumentSymbols('page.html', index, docOf(CUSTOM));
		strictEqual(result.length, 1);
		deepStrictEqual(result[0].range, {
			start: { line: 0, character: 0 },
			end: { line: 2, character: 12 },
		});
		deepStrictEqual(result[0].selectionRange, {
			start: { line: 0, character: 0 },
			end: { line: 0, character: 24 },
		});
	});

	it('gives each partial in a file its own non-overlapping range', () => {
		const content = [
			'<div b-name="first">',
			'  <p>a</p>',
			'</div>',
			'<div b-name="second">',
			'  <p>b</p>',
			'</div>',
		].join('\n');
		const secondStart = content.indexOf('<div b-name="second">');
		const index = makeIndex(
			[
				{ file: 'page.html', name: 'first', exported: false, loc: makeLoc(1, 6, 1, 20), extent: { startOffset: 0, endOffset: content.indexOf('</div>') + '</div>'.length } },
				{ file: 'page.html', name: 'second', exported: false, loc: makeLoc(4, 6, 4, 21), extent: { startOffset: secondStart, endOffset: content.length } },
			],
			[],
		);
		const result = getDocumentSymbols('page.html', index, docOf(content));
		strictEqual(result.length, 2);
		const first = result.find(s => s.name === 'first')!;
		const second = result.find(s => s.name === 'second')!;
		deepStrictEqual(first.range, { start: { line: 0, character: 0 }, end: { line: 2, character: 6 } });
		deepStrictEqual(second.range, { start: { line: 3, character: 0 }, end: { line: 5, character: 6 } });
	});

	it('falls back to the name range when no document is supplied', () => {
		const index = makeIndex(
			[{ file: 'page.html', name: 'page', exported: false, loc: makeLoc(1, 6, 1, 19), extent: { startOffset: 0, endOffset: 39 } }],
			[],
		);
		const result = getDocumentSymbols('page.html', index);
		deepStrictEqual(result[0].range, result[0].selectionRange);
		deepStrictEqual(result[0].range, {
			start: { line: 0, character: 5 },
			end: { line: 0, character: 18 },
		});
	});

	it('falls back to the name range when the def carries no extent', () => {
		const index = makeIndex(
			[{ file: 'page.html', name: 'page', exported: false, loc: makeLoc(1, 6, 1, 19) }],
			[],
		);
		const result = getDocumentSymbols('page.html', index, docOf(NAMED));
		deepStrictEqual(result[0].range, result[0].selectionRange);
	});

	it('falls back when the extent would not contain the name range', () => {
		// A definition whose closing tag was never found leaves a zero-width
		// extent. selectionRange must stay inside range, so a degenerate extent
		// is discarded rather than published.
		const index = makeIndex(
			[{ file: 'page.html', name: 'page', exported: false, loc: makeLoc(1, 6, 1, 19), extent: { startOffset: 0, endOffset: 0 } }],
			[],
		);
		const result = getDocumentSymbols('page.html', index, docOf(NAMED));
		deepStrictEqual(result[0].range, result[0].selectionRange);
	});
});
