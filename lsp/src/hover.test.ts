import { describe, it } from 'node:test';
import { strictEqual, ok, match } from 'node:assert';
import { getHover } from './hover.js';
import { makeIndex, makeLoc } from './test-helpers.js';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { Position } from 'vscode-languageserver';

/** Create a fake TextDocument from lines of text. */
function makeDoc(lines: string[]): TextDocument {
	const text = lines.join('\n');
	return {
		getText(range?: any): string {
			if (!range) return text;
			const allLines = text.split('\n');
			const startLine = range.start.line;
			const endLine = range.end.line;
			// Return the requested line range
			return allLines.slice(startLine, endLine).join('\n') + (endLine > startLine ? '\n' : '');
		},
	} as TextDocument;
}

function pos(line: number, character: number): Position {
	return { line, character };
}

function hoverValue(hover: ReturnType<typeof getHover>): string {
	if (!hover) return '';
	const contents = hover.contents as { kind: string; value: string };
	return contents.value;
}

describe('getHover', () => {
	describe('b-part', () => {
		it('shows partial info with slots and data', () => {
			const index = makeIndex(
				[{ file: 'components.html', name: 'card', loc: makeLoc(1, 1, 1, 20), exported: true, slots: ['default', 'header'], freeVars: ['title', 'items'] }],
				[],
			);
			const doc = makeDoc(['<div b-part="components.html#card"></div>']);
			const result = getHover(doc, pos(0, 20), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('**Partial** `card`'));
			ok(v.includes('`components.html`'));
			ok(v.includes('exported'));
			ok(v.includes('`default`'));
			ok(v.includes('`header`'));
			ok(v.includes('`title`'));
			ok(v.includes('`items`'));
		});

		it('shows not-found for unknown partial', () => {
			const index = makeIndex([], []);
			const doc = makeDoc(['<div b-part="components.html#missing"></div>']);
			const result = getHover(doc, pos(0, 20), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('not found'));
		});

		it('returns null when cursor is outside attribute value', () => {
			const index = makeIndex(
				[{ file: 'page.html', name: 'card', loc: makeLoc(1, 1, 1, 20), exported: false }],
				[],
			);
			const doc = makeDoc(['<div b-part="card" class="x"></div>']);
			// Cursor on "class"
			const result = getHover(doc, pos(0, 22), 'page.html', index);
			strictEqual(result, null);
		});

		it('shows same-file partial without file info', () => {
			const index = makeIndex(
				[{ file: 'page.html', name: 'card', loc: makeLoc(1, 1, 1, 20), exported: false, slots: [], freeVars: ['title'] }],
				[],
			);
			const doc = makeDoc(['<div b-part="#card"></div>']);
			const result = getHover(doc, pos(0, 15), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('**Partial** `card`'));
			ok(!v.includes('page.html'));
		});

		it('shows none for empty slots and data', () => {
			const index = makeIndex(
				[{ file: 'page.html', name: 'simple', loc: makeLoc(1, 1, 1, 20), exported: false, slots: [], freeVars: [] }],
				[],
			);
			const doc = makeDoc(['<div b-part="#simple"></div>']);
			const result = getHover(doc, pos(0, 16), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('**Slots:** none'));
			ok(v.includes('**Data:** none'));
		});
	});

	describe('b-name', () => {
		it('shows partial definition info with refs', () => {
			const index = makeIndex(
				[{ file: 'page.html', name: 'card', loc: makeLoc(1, 1, 1, 20), exported: true, slots: ['default', 'footer'], freeVars: ['title'] }],
				[
					{ file: 'page.html', partialName: 'card', targetFile: null, loc: makeLoc(10, 1, 10, 20) },
					{ file: 'other.html', partialName: 'card', targetFile: 'page.html', loc: makeLoc(5, 1, 5, 20) },
				],
			);
			const doc = makeDoc(['<div b-name="card" b-export>']);
			const result = getHover(doc, pos(0, 16), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('**Partial** `card`'));
			ok(v.includes('Exported'));
			ok(v.includes('2 references'));
			ok(v.includes('`default`'));
			ok(v.includes('`footer`'));
			ok(v.includes('`title`'));
		});

		it('shows 0 references and none for empty slots/data', () => {
			const index = makeIndex(
				[{ file: 'page.html', name: 'lonely', loc: makeLoc(1, 1, 1, 20), exported: false, slots: [], freeVars: [] }],
				[],
			);
			const doc = makeDoc(['<div b-name="lonely">']);
			const result = getHover(doc, pos(0, 16), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('0 references'));
			ok(v.includes('Local'));
			ok(v.includes('**Slots:** none'));
			ok(v.includes('**Data:** none'));
		});
	});

	describe('b-in', () => {
		it('shows slot exists when slot is defined', () => {
			const index = makeIndex(
				[{ file: 'page.html', name: 'card', loc: makeLoc(1, 1, 1, 20), exported: false, slots: ['default', 'header'], freeVars: [] }],
				[],
			);
			const doc = makeDoc([
				'<div b-part="#card">',
				'  <b-unwrap b-in="header">Title</b-unwrap>',
				'</div>',
			]);
			const result = getHover(doc, pos(1, 20), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('`header`'));
			ok(v.includes('partial `card`'));
			ok(v.includes('✓ Slot exists'));
		});

		it('shows slot not found with available slots', () => {
			const index = makeIndex(
				[{ file: 'page.html', name: 'card', loc: makeLoc(1, 1, 1, 20), exported: false, slots: ['default', 'footer'], freeVars: [] }],
				[],
			);
			const doc = makeDoc([
				'<div b-part="#card">',
				'  <b-unwrap b-in="sidebar">Content</b-unwrap>',
				'</div>',
			]);
			const result = getHover(doc, pos(1, 22), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('`sidebar`'));
			ok(v.includes('✗ Slot not found'));
			ok(v.includes('`default`'));
			ok(v.includes('`footer`'));
		});

		it('shows error when no enclosing b-part found', () => {
			const index = makeIndex([], []);
			const doc = makeDoc([
				'<b-unwrap b-in="header">Title</b-unwrap>',
			]);
			const result = getHover(doc, pos(0, 18), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('enclosing b-part not found'));
		});
	});

	describe('b-slot', () => {
		it('shows slot info with parent partial', () => {
			const index = makeIndex([], []);
			const doc = makeDoc([
				'<div b-name="card">',
				'  <b-unwrap b-slot="header" />',
				'</div>',
			]);
			const result = getHover(doc, pos(1, 22), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('`header`'));
			ok(v.includes('partial `card`'));
		});

		it('shows default for bare b-slot', () => {
			const index = makeIndex([], []);
			const doc = makeDoc([
				'<div b-name="card">',
				'  <b-unwrap b-slot />',
				'</div>',
			]);
			const result = getHover(doc, pos(1, 15), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('`default`'));
			ok(v.includes('partial `card`'));
		});

		it('shows error when no enclosing b-name', () => {
			const index = makeIndex([], []);
			const doc = makeDoc([
				'<b-unwrap b-slot="header" />',
			]);
			const result = getHover(doc, pos(0, 20), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('enclosing b-name not found'));
		});
	});

	describe('b-data:', () => {
		it('shows used when var is in partial freeVars', () => {
			const index = makeIndex(
				[{ file: 'page.html', name: 'card', loc: makeLoc(1, 1, 1, 20), exported: false, slots: [], freeVars: ['title', 'items'] }],
				[],
			);
			const doc = makeDoc(['<div b-part="#card" b-data:title="pageTitle"></div>']);
			const result = getHover(doc, pos(0, 28), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('`title`'));
			ok(v.includes('partial `card`'));
			ok(v.includes('✓ Used in partial'));
		});

		it('shows not used when var is not in partial freeVars', () => {
			const index = makeIndex(
				[{ file: 'page.html', name: 'card', loc: makeLoc(1, 1, 1, 20), exported: false, slots: [], freeVars: ['title'] }],
				[],
			);
			const doc = makeDoc(['<div b-part="#card" b-data:unused="val"></div>']);
			const result = getHover(doc, pos(0, 28), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('`unused`'));
			ok(v.includes('✗ Not used in partial'));
		});

		it('shows error when no b-part on line', () => {
			const index = makeIndex([], []);
			const doc = makeDoc(['<div b-data:title="val"></div>']);
			const result = getHover(doc, pos(0, 14), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('no b-part on this element'));
		});
	});

	describe('no match', () => {
		it('returns null for plain HTML', () => {
			const index = makeIndex([], []);
			const doc = makeDoc(['<div class="foo">Hello</div>']);
			const result = getHover(doc, pos(0, 10), 'page.html', index);
			strictEqual(result, null);
		});
	});
});
