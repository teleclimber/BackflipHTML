import { describe, it } from 'node:test';
import { strictEqual, ok, match } from 'node:assert';
import { getHover, findRulesForElement, findElementsForSelector } from './hover.js';
import { makeIndex, makeLoc } from './test-helpers.js';
import { analyzeCss } from '@backflip/css';
import { compileFiles } from '@backflip/html';

async function analyze(input: { cssContent: string; templateFiles: Map<string, string> }) {
	const { directory } = await compileFiles(input.templateFiles);
	return analyzeCss({ cssContent: input.cssContent, compiled: directory.files });
}

import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { Position } from 'vscode-languageserver';

/** Create a fake TextDocument from lines of text. Honours character offsets within each line. */
function makeDoc(lines: string[]): TextDocument {
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
		it('shows partial info with slots and data', async () => {
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

		it('shows not-found for unknown partial', async () => {
			const index = makeIndex([], []);
			const doc = makeDoc(['<div b-part="components.html#missing"></div>']);
			const result = getHover(doc, pos(0, 20), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('not found'));
		});

		it('returns null when cursor is outside attribute value', async () => {
			const index = makeIndex(
				[{ file: 'page.html', name: 'card', loc: makeLoc(1, 1, 1, 20), exported: false }],
				[],
			);
			const doc = makeDoc(['<div b-part="card" class="x"></div>']);
			// Cursor on "class"
			const result = getHover(doc, pos(0, 22), 'page.html', index);
			strictEqual(result, null);
		});

		it('shows same-file partial without file info', async () => {
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

		it('shows none for empty slots and data', async () => {
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

		it('shows rich data shape when dataShape is provided', async () => {
			const dataShape = new Map<string, import('@backflip/html').DataShape>([
				['title', { usages: new Set(['printed'] as const) }],
				['user', {
					usages: new Set<import('@backflip/html').UsageKind>(),
					properties: new Map([
						['name', { usages: new Set(['printed'] as const) }],
						['email', { usages: new Set(['attribute'] as const), attributes: new Set(['href']) }],
					]),
				}],
				['items', { usages: new Set(['iterable', 'boolean'] as const) }],
			]);
			const index = makeIndex(
				[{ file: 'page.html', name: 'card', loc: makeLoc(1, 1, 1, 20), exported: false, freeVars: ['items', 'title', 'user'], dataShape }],
				[],
			);
			const doc = makeDoc(['<div b-part="#card"></div>']);
			const result = getHover(doc, pos(0, 15), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('`title`'), 'should include title');
			ok(v.includes('printed'), 'should show printed usage');
			ok(v.includes('.name'), 'should show property name');
			ok(v.includes('.email'), 'should show property email');
			ok(v.includes('attribute: href'), 'should show attribute name');
			ok(v.includes('iterable'), 'should show iterable usage');
			ok(v.includes('boolean'), 'should show boolean usage');
		});
	});

	describe('b-name', () => {
		it('shows partial definition info with refs', async () => {
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

		it('shows 0 references and none for empty slots/data', async () => {
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
		it('shows slot exists when slot is defined', async () => {
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

		it('shows slot not found with available slots', async () => {
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

		it('shows error when no enclosing b-part found', async () => {
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
		it('shows slot info with parent partial', async () => {
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

		it('shows default for bare b-slot', async () => {
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

		it('shows error when no enclosing b-name', async () => {
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
		it('shows used when var is in partial freeVars', async () => {
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

		it('shows not used when var is not in partial freeVars', async () => {
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

		it('shows error when no enclosing partial reference on line', async () => {
			const index = makeIndex([], []);
			const doc = makeDoc(['<div b-data:title="val"></div>']);
			const result = getHover(doc, pos(0, 14), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('no enclosing partial reference'));
		});

		it('resolves partial via custom-element call site (no b-part on line)', async () => {
			const index = makeIndex(
				[{
					file: 'components.html', name: 'my-card',
					loc: makeLoc(1, 1, 1, 10), exported: true, customElement: true,
					slots: [], freeVars: ['checklistid'],
				}],
				[],
			);
			const doc = makeDoc(['<my-card b-data:checklistid="42"></my-card>']);
			const result = getHover(doc, pos(0, 12), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('`checklistid`'));
			ok(v.includes('partial `my-card`'));
			ok(v.includes('✓ Used in partial'));
		});

		it('resolves partial when the opening tag spans multiple lines', async () => {
			const index = makeIndex(
				[{
					file: 'components.html', name: 'my-card',
					loc: makeLoc(1, 1, 1, 10), exported: true, customElement: true,
					slots: [], freeVars: ['checklistid'],
				}],
				[],
			);
			const doc = makeDoc([
				'<my-card',
				'  b-data:checklistid="42"',
				'>',
				'</my-card>',
			]);
			// cursor on `checklistid` (line 1)
			const result = getHover(doc, pos(1, 12), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('`checklistid`'));
			ok(v.includes('partial `my-card`'));
			ok(v.includes('✓ Used in partial'));
		});

		it('flags b-data: that conflicts with a declared b-attr on the call site', async () => {
			const index = makeIndex(
				[{
					file: 'components.html', name: 'my-card',
					loc: makeLoc(1, 1, 1, 10), exported: true, customElement: true,
					slots: [], freeVars: ['premium'],
					bAttrs: [{ name: 'premium', isBool: true }],
				}],
				[],
			);
			const doc = makeDoc(['<my-card b-data:premium="x"></my-card>']);
			const result = getHover(doc, pos(0, 12), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('Conflicts with declared `b-attr:premium`'));
		});
	});

	describe('custom element partial', () => {
		it('shows partial info on def site (open tag, same file)', async () => {
			const index = makeIndex(
				[{
					file: 'components.html', name: 'my-card',
					loc: makeLoc(1, 1, 1, 10), exported: true, customElement: true,
					slots: ['default', 'header'], freeVars: ['title'],
				}],
				[
					{ file: 'page.html', partialName: 'my-card', targetFile: 'components.html', loc: makeLoc(3, 1, 3, 10) },
				],
			);
			const doc = makeDoc(['<my-card b-export>', '  Body', '</my-card>']);
			// Cursor on the open tag name
			const result = getHover(doc, pos(0, 4), 'components.html', index);
			const v = hoverValue(result);
			ok(v.includes('Custom element partial'));
			ok(v.includes('`<my-card>`'));
			ok(v.includes('Exported'));
			ok(v.includes('1 reference'));
			ok(v.includes('`default`'));
			ok(v.includes('`header`'));
			ok(v.includes('`title`'));
		});

		it('shows partial info on call site (cross-file)', async () => {
			const index = makeIndex(
				[{
					file: 'components.html', name: 'my-card',
					loc: makeLoc(1, 1, 1, 10), exported: true, customElement: true,
					slots: ['default'], freeVars: ['title'],
				}],
				[],
			);
			const doc = makeDoc([
				'<div b-name="page">',
				'  <my-card></my-card>',
				'</div>',
			]);
			// Cursor on the call site tag name
			const result = getHover(doc, pos(1, 5), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('Custom element partial'));
			ok(v.includes('`<my-card>`'));
			ok(v.includes('`components.html`'));
			ok(v.includes('exported'));
			ok(v.includes('`default`'));
			ok(v.includes('`title`'));
		});

		it('shows call-site style on closing tag of def', async () => {
			const index = makeIndex(
				[{
					file: 'components.html', name: 'my-card',
					loc: makeLoc(1, 1, 1, 10), exported: false, customElement: true,
					slots: [], freeVars: [],
				}],
				[],
			);
			const doc = makeDoc(['<my-card>', '</my-card>']);
			// Cursor on the closing tag of the def
			const result = getHover(doc, pos(1, 4), 'components.html', index);
			const v = hoverValue(result);
			ok(v.includes('Custom element partial'));
			ok(v.includes('`<my-card>`'));
			// Closing tag is treated as a call site (not the def's open-tag location)
			ok(!v.includes('Exported') && !v.includes('Local'));
		});

		it('shows call-site style on same-file call', async () => {
			const index = makeIndex(
				[{
					file: 'page.html', name: 'my-notice',
					loc: makeLoc(1, 1, 1, 12), exported: false, customElement: true,
					slots: [], freeVars: [],
				}],
				[],
			);
			const doc = makeDoc([
				'<my-notice>Notice!</my-notice>',
				'<div b-name="post">',
				'  <my-notice></my-notice>',
				'</div>',
			]);
			// Cursor on the call site (line 2)
			const result = getHover(doc, pos(2, 6), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('Custom element partial'));
			ok(v.includes('`<my-notice>`'));
			// Same-file call: no file info shown, no Exported/Local label
			ok(!v.includes('Exported') && !v.includes('Local'));
		});

		it('returns null for plain HTML tag', async () => {
			const index = makeIndex([], []);
			const doc = makeDoc(['<div>Hello</div>']);
			const result = getHover(doc, pos(0, 2), 'page.html', index);
			strictEqual(result, null);
		});

		it('returns null for unknown custom element tag', async () => {
			const index = makeIndex([], []);
			const doc = makeDoc(['<unknown-tag></unknown-tag>']);
			const result = getHover(doc, pos(0, 3), 'page.html', index);
			strictEqual(result, null);
		});

		it('does not match b-* directive tags', async () => {
			const index = makeIndex(
				[{
					file: 'page.html', name: 'b-unwrap',
					loc: makeLoc(1, 1, 1, 12), exported: false, customElement: true,
					slots: [], freeVars: [],
				}],
				[],
			);
			const doc = makeDoc(['<b-unwrap></b-unwrap>']);
			const result = getHover(doc, pos(0, 3), 'page.html', index);
			strictEqual(result, null);
		});

		it('shows Attributes section listing b-attrs with their type', async () => {
			const dataShape = new Map<string, import('@backflip/html').DataShape>([
				['label', { usages: new Set(['printed'] as const), scalar: 'string' }],
				['premium', { usages: new Set(['boolean'] as const), scalar: 'bool' }],
			]);
			const index = makeIndex(
				[{
					file: 'components.html', name: 'my-card',
					loc: makeLoc(1, 1, 1, 10), exported: true, customElement: true,
					slots: ['default'], freeVars: ['label', 'premium'], dataShape,
					bAttrs: [{ name: 'label', isBool: false }, { name: 'premium', isBool: true }],
				}],
				[],
			);
			const doc = makeDoc(['<my-card label="hi" premium></my-card>']);
			const result = getHover(doc, pos(0, 4), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('**Slots:**'), 'should show Slots section');
			ok(v.includes('**Attributes:**'), 'should show Attributes section');
			ok(v.includes('`label` — string · printed'), 'should show string attr with usage');
			ok(v.includes('`premium` — bool · boolean'), 'should show bool attr with usage');
			ok(v.includes('**Data:**'), 'should still show Data section');
			// b-attr names should be excluded from Data section to avoid duplication
			const dataIdx = v.indexOf('**Data:**');
			const dataSection = v.slice(dataIdx);
			ok(!dataSection.includes('`label`'), 'label should not appear under Data');
			ok(!dataSection.includes('`premium`'), 'premium should not appear under Data');
		});

		it('Attributes section also shows for unused b-attrs without usage suffix', async () => {
			const dataShape = new Map<string, import('@backflip/html').DataShape>([
				['flag', { usages: new Set(), scalar: 'bool' }],
			]);
			const index = makeIndex(
				[{
					file: 'components.html', name: 'my-tag',
					loc: makeLoc(1, 1, 1, 10), exported: false, customElement: true,
					slots: [], freeVars: ['flag'], dataShape,
					bAttrs: [{ name: 'flag', isBool: true }],
				}],
				[],
			);
			const doc = makeDoc(['<my-tag></my-tag>']);
			const result = getHover(doc, pos(0, 3), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('**Attributes:**'));
			ok(v.includes('`flag` — bool'));
			ok(!v.includes('`flag` — bool ·'), 'should not include trailing usage separator for unused b-attr');
		});

		it('omits Attributes section when partial has no b-attrs', async () => {
			const index = makeIndex(
				[{
					file: 'components.html', name: 'plain-tag',
					loc: makeLoc(1, 1, 1, 10), exported: false, customElement: true,
					slots: [], freeVars: [],
				}],
				[],
			);
			const doc = makeDoc(['<plain-tag></plain-tag>']);
			const result = getHover(doc, pos(0, 3), 'page.html', index);
			const v = hoverValue(result);
			ok(!v.includes('**Attributes:**'));
		});

		it('does not match a non-customElement partial that happens to have a hyphen in its b-name', async () => {
			const index = makeIndex(
				[{
					file: 'page.html', name: 'my-thing',
					loc: makeLoc(1, 1, 1, 12), exported: false, customElement: false,
					slots: [], freeVars: [],
				}],
				[],
			);
			const doc = makeDoc(['<my-thing></my-thing>']);
			const result = getHover(doc, pos(0, 3), 'page.html', index);
			strictEqual(result, null);
		});
	});

	describe('b-attr call site', () => {
		function bAttrIndex() {
			const dataShape = new Map<string, import('@backflip/html').DataShape>([
				['label', { usages: new Set(['printed'] as const), scalar: 'string' }],
				['premium', { usages: new Set(['boolean'] as const), scalar: 'bool' }],
			]);
			return makeIndex(
				[{
					file: 'components.html', name: 'my-card',
					loc: makeLoc(1, 1, 1, 10), exported: true, customElement: true,
					slots: [], freeVars: ['label', 'premium'], dataShape,
					bAttrs: [{ name: 'label', isBool: false }, { name: 'premium', isBool: true }],
				}],
				[],
			);
		}

		it('shows b-attr info on a plain attribute at the call site', async () => {
			const index = bAttrIndex();
			const doc = makeDoc(['<my-card label="hi"></my-card>']);
			// cursor on `label`
			const result = getHover(doc, pos(0, 12), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('**Attribute** `label`'));
			ok(v.includes('partial `my-card`'));
			ok(v.includes('Type: string · printed'));
		});

		it('shows b-attr info on a bare boolean attribute', async () => {
			const index = bAttrIndex();
			const doc = makeDoc(['<my-card premium></my-card>']);
			// cursor on `premium`
			const result = getHover(doc, pos(0, 12), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('**Attribute** `premium`'));
			ok(v.includes('Type: bool · boolean'));
		});

		it('shows b-attr info on `:attr` shorthand bind', async () => {
			const index = bAttrIndex();
			const doc = makeDoc(['<my-card :premium="isPro"></my-card>']);
			// cursor on `premium` (after the `:`)
			const result = getHover(doc, pos(0, 12), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('**Attribute** `premium`'));
			ok(v.includes('Type: bool'));
		});

		it('shows b-attr info on `b-bind:attr`', async () => {
			const index = bAttrIndex();
			const doc = makeDoc(['<my-card b-bind:label="t"></my-card>']);
			// cursor on `label` part of b-bind:label
			const result = getHover(doc, pos(0, 18), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('**Attribute** `label`'));
			ok(v.includes('Type: string'));
		});

		it('handles `.bool` modifier on `:attr`', async () => {
			const index = bAttrIndex();
			const doc = makeDoc(['<my-card :premium.bool="isPro"></my-card>']);
			// cursor on `premium`
			const result = getHover(doc, pos(0, 12), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('**Attribute** `premium`'));
		});

		it('returns null for an attribute that is not a declared b-attr', async () => {
			const index = bAttrIndex();
			const doc = makeDoc(['<my-card class="foo"></my-card>']);
			// cursor on `class`
			const result = getHover(doc, pos(0, 12), 'page.html', index);
			strictEqual(result, null);
		});

		it('returns null when not on a custom-element call site', async () => {
			const index = bAttrIndex();
			const doc = makeDoc(['<div label="hi"></div>']);
			const result = getHover(doc, pos(0, 7), 'page.html', index);
			strictEqual(result, null);
		});

		it('resolves the b-attr when the opening tag spans multiple lines', async () => {
			const index = bAttrIndex();
			const doc = makeDoc([
				'<my-card',
				'  label="hi"',
				'  :premium="isPro"',
				'>',
				'</my-card>',
			]);
			// cursor on `label` (line 1)
			let result = getHover(doc, pos(1, 4), 'page.html', index);
			let v = hoverValue(result);
			ok(v.includes('**Attribute** `label`'));
			ok(v.includes('Type: string'));

			// cursor on `premium` (line 2, inside `:premium`)
			result = getHover(doc, pos(2, 6), 'page.html', index);
			v = hoverValue(result);
			ok(v.includes('**Attribute** `premium`'));
			ok(v.includes('Type: bool'));
		});

		it('does not match when the cursor is past the opening tag close', async () => {
			const index = bAttrIndex();
			const doc = makeDoc([
				'<my-card label="hi">',
				'  Some content',
				'</my-card>',
			]);
			// cursor on `Some` — outside the opening tag
			const result = getHover(doc, pos(1, 4), 'page.html', index);
			strictEqual(result, null);
		});
	});

	describe('no match', () => {
		it('returns null for plain HTML without CSS analysis', async () => {
			const index = makeIndex([], []);
			const doc = makeDoc(['<div class="foo">Hello</div>']);
			const result = getHover(doc, pos(0, 10), 'page.html', index);
			strictEqual(result, null);
		});
	});

	describe('CSS rules', () => {
		function makeCssAnalysis(file: string, matches: Array<{
			startLine: number;
			startCol: number;
			rules: Array<{ selector: string; specificity: [number, number, number]; properties?: Array<{ name: string; value: string }>; media?: string[]; matchType?: string; sourceLine?: number; sourceCol?: number }>;
		}>) {
			const elementMatches = new Map();
			elementMatches.set(file, matches.map(m => ({
				element: null,
				file,
				partialName: 'test',
				startLine: m.startLine,
				startCol: m.startCol,
				startOffset: 0,
				matches: m.rules.map(r => ({
					rule: {
						selectorText: r.selector,
						selectors: [r.selector],
						properties: r.properties ?? [],
						mediaConditions: r.media ?? [],
						sourceLine: r.sourceLine ?? 1,
						sourceCol: r.sourceCol ?? 1,
					},
					selector: r.selector,
					specificity: r.specificity,
					mediaConditions: r.media ?? [],
					matchType: r.matchType ?? 'definite',
				})),
			})));
			return { elementMatches, rules: [] };
		}

		it('shows CSS rules on hover', async () => {
			const index = makeIndex([], []);
			const cssAnalysis = makeCssAnalysis('page.html', [{
				startLine: 1,
				startCol: 1,
				rules: [
					{ selector: '.card', specificity: [0, 1, 0], properties: [{ name: 'color', value: 'red' }] },
				],
			}]);
			const doc = makeDoc(['<div class="card">Hello</div>']);
			const result = getHover(doc, pos(0, 5), 'page.html', index, cssAnalysis as any);
			const v = hoverValue(result);
			ok(v.includes('**CSS Rules**'));
			ok(v.includes('`.card`'));
			ok(v.includes('(0, 1, 0)'));
			ok(v.includes('color: red'));
		});

		it('shows media conditions', async () => {
			const index = makeIndex([], []);
			const cssAnalysis = makeCssAnalysis('page.html', [{
				startLine: 1,
				startCol: 1,
				rules: [
					{ selector: '.card', specificity: [0, 1, 0], media: ['(min-width:768px)'] },
				],
			}]);
			const doc = makeDoc(['<div class="card">Hello</div>']);
			const result = getHover(doc, pos(0, 5), 'page.html', index, cssAnalysis as any);
			const v = hoverValue(result);
			ok(v.includes('@media'));
			ok(v.includes('(min-width:768px)'));
		});

		it('shows match type for conditional matches', async () => {
			const index = makeIndex([], []);
			const cssAnalysis = makeCssAnalysis('page.html', [{
				startLine: 1,
				startCol: 1,
				rules: [
					{ selector: 'span', specificity: [0, 0, 1], matchType: 'conditional' },
				],
			}]);
			const doc = makeDoc(['<span>Hello</span>']);
			const result = getHover(doc, pos(0, 2), 'page.html', index, cssAnalysis as any);
			const v = hoverValue(result);
			ok(v.includes('*conditional*'));
		});

		it('returns null when no CSS analysis available', async () => {
			const index = makeIndex([], []);
			const doc = makeDoc(['<div class="card">Hello</div>']);
			const result = getHover(doc, pos(0, 5), 'page.html', index, null);
			strictEqual(result, null);
		});

		it('shows CSS file name and line number when cssPaths is provided', async () => {
			const index = makeIndex([], []);
			const cssAnalysis = makeCssAnalysis('page.html', [{
				startLine: 1,
				startCol: 1,
				rules: [
					{ selector: '.card', specificity: [0, 1, 0], properties: [{ name: 'color', value: 'red' }], sourceLine: 10 },
				],
			}]);
			const doc = makeDoc(['<div class="card">Hello</div>']);
			const result = getHover(doc, pos(0, 5), 'page.html', index, cssAnalysis as any, ['/workspace/styles.css']);
			const v = hoverValue(result);
			ok(v.includes('styles.css:10'), 'should include file name and line number');
			ok(v.includes('command:backflipHTML.openFileAtLocation'), 'should include command URI');
		});

		it('shows correct line numbers for multiple rules', async () => {
			const index = makeIndex([], []);
			const cssAnalysis = makeCssAnalysis('page.html', [{
				startLine: 1,
				startCol: 1,
				rules: [
					{ selector: '.a', specificity: [0, 1, 0], sourceLine: 5 },
					{ selector: '.b', specificity: [0, 1, 0], sourceLine: 12 },
				],
			}]);
			const doc = makeDoc(['<div class="a b">Hello</div>']);
			const result = getHover(doc, pos(0, 5), 'page.html', index, cssAnalysis as any, ['/workspace/theme.css']);
			const v = hoverValue(result);
			ok(v.includes('theme.css:5'), 'should include first rule line');
			ok(v.includes('theme.css:12'), 'should include second rule line');
		});

		it('does not show file link when cssPaths is not provided', async () => {
			const index = makeIndex([], []);
			const cssAnalysis = makeCssAnalysis('page.html', [{
				startLine: 1,
				startCol: 1,
				rules: [
					{ selector: '.card', specificity: [0, 1, 0] },
				],
			}]);
			const doc = makeDoc(['<div class="card">Hello</div>']);
			const result = getHover(doc, pos(0, 5), 'page.html', index, cssAnalysis as any);
			const v = hoverValue(result);
			ok(!v.includes('command:'), 'should not include command URI without cssPaths');
		});

		it('returns null when cursor not on HTML tag', async () => {
			const index = makeIndex([], []);
			const cssAnalysis = makeCssAnalysis('page.html', [{
				startLine: 1,
				startCol: 1,
				rules: [{ selector: '.card', specificity: [0, 1, 0] }],
			}]);
			const doc = makeDoc(['Hello world']);
			const result = getHover(doc, pos(0, 5), 'page.html', index, cssAnalysis as any);
			strictEqual(result, null);
		});
	});
});

describe('CSS selector hover (hover in CSS file)', () => {
	function makeCssAnalysisWithElements(entries: Array<{
		file: string;
		partialName: string;
		startLine: number;
		startCol: number;
		selector: string;
		ruleLine: number;
		matchType?: string;
	}>) {
		const elementMatches = new Map<string, any[]>();
		for (const e of entries) {
			const arr = elementMatches.get(e.file) ?? [];
			// Check if there's already an element at this line
			let existing = arr.find((m: any) => m.startLine === e.startLine && m.startCol === e.startCol);
			if (!existing) {
				existing = {
					element: null,
					file: e.file,
					partialName: e.partialName,
					startLine: e.startLine,
					startCol: e.startCol,
					startOffset: 0,
					matches: [],
				};
				arr.push(existing);
			}
			existing.matches.push({
				rule: {
					selectorText: e.selector,
					selectors: [e.selector],
					properties: [],
					mediaConditions: [],
					sourceLine: e.ruleLine,
					sourceCol: 1,
				},
				selector: e.selector,
				specificity: [0, 1, 0] as [number, number, number],
				mediaConditions: [],
				matchType: e.matchType ?? 'definite',
			});
			elementMatches.set(e.file, arr);
		}
		return { elementMatches, rules: [] };
	}

	// cssPaths are absolute, templateRoot is absolute
	// filePath passed to getHover is path.relative(templateRoot, absoluteFilePath)
	// So for stylesheet at /workspace/styles.css and templateRoot /workspace/templates,
	// filePath would be ../styles.css
	const ssPath = '/workspace/styles.css';
	const tplRoot = '/workspace/templates';
	const ssRelPath = '../styles.css'; // path.relative(tplRoot, ssPath)

	it('shows matching partials when hovering on a CSS selector line', async () => {
		const index = makeIndex([], []);
		const cssAnalysis = makeCssAnalysisWithElements([
			{ file: 'page.html', partialName: 'card', startLine: 5, startCol: 3, selector: '.card', ruleLine: 2 },
		]);
		const doc = makeDoc([
			'/* styles */',
			'.card {',
			'  color: red;',
			'}',
		]);
		const result = getHover(doc, pos(1, 3), ssRelPath, index, cssAnalysis as any, [ssPath], tplRoot);
		const v = hoverValue(result);
		ok(v.includes('**Matched elements**'), 'should show matched elements header');
		ok(v.includes('card'), 'should show partial name');
		ok(v.includes('page.html'), 'should show file name');
	});

	it('shows multiple partials from different files', async () => {
		const index = makeIndex([], []);
		const cssAnalysis = makeCssAnalysisWithElements([
			{ file: 'page.html', partialName: 'card', startLine: 5, startCol: 3, selector: '.title', ruleLine: 1 },
			{ file: 'other.html', partialName: 'header', startLine: 3, startCol: 1, selector: '.title', ruleLine: 1 },
		]);
		const doc = makeDoc(['.title { font-size: 16px; }']);
		const result = getHover(doc, pos(0, 3), ssRelPath, index, cssAnalysis as any, [ssPath], tplRoot);
		const v = hoverValue(result);
		ok(v.includes('card'), 'should show first partial');
		ok(v.includes('header'), 'should show second partial');
		ok(v.includes('page.html'), 'should show first file');
		ok(v.includes('other.html'), 'should show second file');
	});

	it('includes clickable link to element location', async () => {
		const index = makeIndex([], []);
		const cssAnalysis = makeCssAnalysisWithElements([
			{ file: 'page.html', partialName: 'card', startLine: 5, startCol: 3, selector: '.card', ruleLine: 1 },
		]);
		const doc = makeDoc(['.card { color: red; }']);
		const result = getHover(doc, pos(0, 3), ssRelPath, index, cssAnalysis as any, [ssPath], tplRoot);
		const v = hoverValue(result);
		ok(v.includes('command:backflipHTML.openFileAtLocation'), 'should include command URI');
		// Path is URL-encoded in the command URI
		ok(v.includes(encodeURIComponent('/workspace/templates/page.html')), 'should include full path to template');
	});

	it('shows match type for non-definite matches', async () => {
		const index = makeIndex([], []);
		const cssAnalysis = makeCssAnalysisWithElements([
			{ file: 'page.html', partialName: 'card', startLine: 5, startCol: 3, selector: '.card', ruleLine: 1, matchType: 'conditional' },
		]);
		const doc = makeDoc(['.card { color: red; }']);
		const result = getHover(doc, pos(0, 3), ssRelPath, index, cssAnalysis as any, [ssPath], tplRoot);
		const v = hoverValue(result);
		ok(v.includes('conditional'), 'should show match type');
	});

	it('returns null when hovering on a non-selector line (e.g. property)', async () => {
		const index = makeIndex([], []);
		const cssAnalysis = makeCssAnalysisWithElements([
			{ file: 'page.html', partialName: 'card', startLine: 5, startCol: 3, selector: '.card', ruleLine: 1 },
		]);
		const doc = makeDoc([
			'.card {',
			'  color: red;',
			'}',
		]);
		const result = getHover(doc, pos(1, 5), ssRelPath, index, cssAnalysis as any, [ssPath], tplRoot);
		strictEqual(result, null);
	});

	it('returns null when not hovering on the stylesheet file', async () => {
		const index = makeIndex([], []);
		const cssAnalysis = makeCssAnalysisWithElements([
			{ file: 'page.html', partialName: 'card', startLine: 5, startCol: 3, selector: '.card', ruleLine: 1 },
		]);
		const doc = makeDoc(['.card { color: red; }']);
		const result = getHover(doc, pos(0, 3), 'other.css', index, cssAnalysis as any, [ssPath], tplRoot);
		strictEqual(result, null);
	});

	it('returns null when no elements match the selector', async () => {
		const index = makeIndex([], []);
		const cssAnalysis = makeCssAnalysisWithElements([
			{ file: 'page.html', partialName: 'card', startLine: 5, startCol: 3, selector: '.card', ruleLine: 3 },
		]);
		const doc = makeDoc(['.unmatched { color: red; }']);
		// Rule is on line 3, but we're hovering line 1 (0-based 0)
		const result = getHover(doc, pos(0, 3), ssRelPath, index, cssAnalysis as any, [ssPath], tplRoot);
		strictEqual(result, null);
	});
});

describe('getHover integration (analyzeCss + getHover)', () => {
	it('shows CSS rules for elements inside a partial', async () => {
		const html = [
			'<div b-name="card">',
			'  <div class="card-body">content</div>',
			'</div>',
		].join('\n');
		const css = '.card-body { padding: 8px; }';
		const cssAnalysis = await analyze({
			cssContent: css,
			templateFiles: new Map([['page.html', html]]),
		});
		const doc = makeDoc(html.split('\n'));
		// Hover on the div.card-body (line 1, 0-based)
		const result = getHover(doc, pos(1, 5), 'page.html', makeIndex([], []), cssAnalysis);
		const v = hoverValue(result);
		ok(v.includes('**CSS Rules**'), 'should show CSS rules header');
		ok(v.includes('.card-body'), 'should show .card-body selector');
	});

	it('shows CSS rules for slot content (b-in) with ancestors inside the partial', async () => {
		const html = [
			'<div b-name="card">',
			'  <div class="card-header">',
			'    <b-unwrap b-slot="header" />',
			'  </div>',
			'</div>',
			'<div b-name="page">',
			'  <div b-part="#card">',
			'    <h2 b-in="header">Title</h2>',
			'  </div>',
			'</div>',
		].join('\n');
		const css = '.card-header h2 { color: red; }';
		const cssAnalysis = await analyze({
			cssContent: css,
			templateFiles: new Map([['page.html', html]]),
		});
		const doc = makeDoc(html.split('\n'));
		// Hover on the h2 (line 7, 0-based)
		const result = getHover(doc, pos(7, 6), 'page.html', makeIndex([], []), cssAnalysis);
		const v = hoverValue(result);
		ok(v.includes('**CSS Rules**'), 'should show CSS rules for b-in element');
		ok(v.includes('.card-header h2'), 'should match descendant selector through slot');
	});

	it('shows CSS rules for slot content with ancestors above the calling partial', async () => {
		const html = [
			'<div b-name="card">',
			'  <div class="card-body">',
			'    <b-unwrap b-slot />',
			'  </div>',
			'</div>',
			'<div b-name="page">',
			'  <div class="page-wrapper">',
			'    <div b-part="#card">',
			'      <p b-in="default">Content</p>',
			'    </div>',
			'  </div>',
			'</div>',
		].join('\n');
		const css = '.page-wrapper .card-body p { margin: 0; }';
		const cssAnalysis = await analyze({
			cssContent: css,
			templateFiles: new Map([['page.html', html]]),
		});
		const doc = makeDoc(html.split('\n'));
		// Hover on the p (line 8, 0-based)
		const result = getHover(doc, pos(8, 8), 'page.html', makeIndex([], []), cssAnalysis);
		const v = hoverValue(result);
		ok(v.includes('**CSS Rules**'), 'should show CSS rules for b-in element');
		ok(v.includes('.page-wrapper .card-body p'), 'should match selector spanning caller and partial');
	});

	it('shows CSS rules for slot content in cross-file partials', async () => {
		const componentHtml = [
			'<div b-name="card" b-export>',
			'  <div class="card-header">',
			'    <b-unwrap b-slot="header" />',
			'  </div>',
			'</div>',
		].join('\n');
		const pageHtml = [
			'<div b-name="page">',
			'  <div b-part="components.html#card">',
			'    <span b-in="header">Title</span>',
			'  </div>',
			'</div>',
		].join('\n');
		const css = '.card-header span { font-weight: bold; }';
		const cssAnalysis = await analyze({
			cssContent: css,
			templateFiles: new Map([
				['components.html', componentHtml],
				['page.html', pageHtml],
			]),
		});
		const doc = makeDoc(pageHtml.split('\n'));
		// Hover on the span (line 2, 0-based)
		const result = getHover(doc, pos(2, 6), 'page.html', makeIndex([], []), cssAnalysis);
		const v = hoverValue(result);
		ok(v.includes('**CSS Rules**'), 'should show CSS rules for cross-file slot content');
		ok(v.includes('.card-header span'), 'should match selector from cross-file partial');
	});
});

describe('CSS selector hover integration (analyzeCss + getHover on CSS file)', () => {
	it('shows matching partials when hovering a selector in the CSS file', async () => {
		const html = [
			'<div b-name="card">',
			'  <div class="card-body">content</div>',
			'</div>',
		].join('\n');
		const css = '.card-body { padding: 8px; }';
		const cssAnalysis = await analyze({
			cssContent: css,
			templateFiles: new Map([['page.html', html]]),
		});
		const doc = makeDoc(css.split('\n'));
		// Hover on .card-body selector (line 0, 0-based) — rule is on line 1 (1-based)
		const result = getHover(doc, pos(0, 3), '../styles.css', makeIndex([], []), cssAnalysis, ['/workspace/styles.css'], '/workspace/templates');
		const v = hoverValue(result);
		ok(v.includes('**Matched elements**'), 'should show matched elements header');
		ok(v.includes('card'), 'should show partial name');
		ok(v.includes('page.html'), 'should show file name');
	});

	it('shows matches from multiple files', async () => {
		const componentHtml = [
			'<div b-name="card" b-export>',
			'  <h2 class="title">heading</h2>',
			'</div>',
		].join('\n');
		const pageHtml = [
			'<div b-name="page">',
			'  <span class="title">page title</span>',
			'</div>',
		].join('\n');
		const css = '.title { color: blue; }';
		const cssAnalysis = await analyze({
			cssContent: css,
			templateFiles: new Map([
				['components.html', componentHtml],
				['page.html', pageHtml],
			]),
		});
		const doc = makeDoc(css.split('\n'));
		const result = getHover(doc, pos(0, 3), '../styles.css', makeIndex([], []), cssAnalysis, ['/workspace/styles.css'], '/workspace/templates');
		const v = hoverValue(result);
		ok(v.includes('card'), 'should show card partial');
		ok(v.includes('page'), 'should show page partial');
		ok(v.includes('components.html'), 'should show components file');
		ok(v.includes('page.html'), 'should show page file');
	});
});

describe('findRulesForElement', () => {
	function makeCssAnalysis(file: string, matches: Array<{
		startLine: number;
		startCol: number;
		rules: Array<{
			selector: string;
			specificity: [number, number, number];
			properties?: Array<{ name: string; value: string }>;
			media?: string[];
			matchType?: string;
			sourceLine?: number;
			sourceCol?: number;
		}>;
	}>) {
		const elementMatches = new Map();
		elementMatches.set(file, matches.map(m => ({
			element: null,
			file,
			partialName: 'test',
			startLine: m.startLine,
			startCol: m.startCol,
			startOffset: 0,
			matches: m.rules.map(r => ({
				rule: {
					selectorText: r.selector,
					selectors: [r.selector],
					properties: r.properties ?? [],
					mediaConditions: r.media ?? [],
					sourceLine: r.sourceLine ?? 1,
					sourceCol: r.sourceCol ?? 1,
				},
				selector: r.selector,
				specificity: r.specificity,
				mediaConditions: r.media ?? [],
				matchType: r.matchType ?? 'definite',
			})),
		})));
		return { elementMatches, rules: [] };
	}

	it('returns structured data for matching element', async () => {
		const cssAnalysis = makeCssAnalysis('page.html', [{
			startLine: 1,
			startCol: 1,
			rules: [
				{ selector: '.card', specificity: [0, 1, 0], properties: [{ name: 'color', value: 'red' }], sourceLine: 5, sourceCol: 3 },
			],
		}]);
		const result = findRulesForElement('<div class="card">Hello</div>', 0, 5, 'page.html', cssAnalysis as any);
		ok(result, 'should return a result');
		strictEqual(result!.tagName, 'div');
		strictEqual(result!.rules.length, 1);
		strictEqual(result!.rules[0].selector, '.card');
		strictEqual(result!.rules[0].specificity[1], 1);
		strictEqual(result!.rules[0].properties[0].name, 'color');
		strictEqual(result!.rules[0].sourceLine, 5);
	});

	it('returns null when no element matches', async () => {
		const cssAnalysis = makeCssAnalysis('page.html', [{
			startLine: 2,
			startCol: 1,
			rules: [{ selector: '.card', specificity: [0, 1, 0] }],
		}]);
		const result = findRulesForElement('<div>Hello</div>', 0, 5, 'page.html', cssAnalysis as any);
		strictEqual(result, null);
	});

	it('returns null for non-tag lines', async () => {
		const cssAnalysis = makeCssAnalysis('page.html', []);
		const result = findRulesForElement('Hello world', 0, 5, 'page.html', cssAnalysis as any);
		strictEqual(result, null);
	});
});

describe('findElementsForSelector', () => {
	function makeCssAnalysisWithElements(entries: Array<{
		file: string;
		partialName: string;
		startLine: number;
		startCol: number;
		selector: string;
		ruleLine: number;
		matchType?: string;
	}>) {
		const elementMatches = new Map<string, any[]>();
		for (const e of entries) {
			const arr = elementMatches.get(e.file) ?? [];
			let existing = arr.find((m: any) => m.startLine === e.startLine && m.startCol === e.startCol);
			if (!existing) {
				existing = {
					element: null,
					file: e.file,
					partialName: e.partialName,
					startLine: e.startLine,
					startCol: e.startCol,
					startOffset: 0,
					matches: [],
				};
				arr.push(existing);
			}
			existing.matches.push({
				rule: {
					selectorText: e.selector,
					selectors: [e.selector],
					properties: [],
					mediaConditions: [],
					sourceLine: e.ruleLine,
					sourceCol: 1,
				},
				selector: e.selector,
				specificity: [0, 1, 0] as [number, number, number],
				mediaConditions: [],
				matchType: e.matchType ?? 'definite',
			});
			elementMatches.set(e.file, arr);
		}
		return { elementMatches, rules: [] };
	}

	const ssPath = '/workspace/styles.css';
	const tplRoot = '/workspace/templates';
	const ssRelPath = '../styles.css';

	it('returns matching elements for a selector line', async () => {
		const cssAnalysis = makeCssAnalysisWithElements([
			{ file: 'page.html', partialName: 'card', startLine: 5, startCol: 3, selector: '.card', ruleLine: 1 },
			{ file: 'page.html', partialName: 'header', startLine: 10, startCol: 1, selector: '.card', ruleLine: 1 },
		]);
		const result = findElementsForSelector(ssRelPath, 0, cssAnalysis as any, [ssPath], tplRoot);
		ok(result, 'should return matches');
		strictEqual(result!.length, 2);
		strictEqual(result![0].partialName, 'card');
		strictEqual(result![1].partialName, 'header');
	});

	it('deduplicates by file + partialName + startLine', async () => {
		const cssAnalysis = makeCssAnalysisWithElements([
			{ file: 'page.html', partialName: 'card', startLine: 5, startCol: 3, selector: '.a', ruleLine: 1 },
			{ file: 'page.html', partialName: 'card', startLine: 5, startCol: 3, selector: '.b', ruleLine: 1 },
		]);
		const result = findElementsForSelector(ssRelPath, 0, cssAnalysis as any, [ssPath], tplRoot);
		ok(result, 'should return matches');
		strictEqual(result!.length, 1, 'should deduplicate');
	});

	it('returns null when not in stylesheet file', async () => {
		const cssAnalysis = makeCssAnalysisWithElements([
			{ file: 'page.html', partialName: 'card', startLine: 5, startCol: 3, selector: '.card', ruleLine: 1 },
		]);
		const result = findElementsForSelector('other.css', 0, cssAnalysis as any, [ssPath], tplRoot);
		strictEqual(result, null);
	});

	it('returns null when no matches on line', async () => {
		const cssAnalysis = makeCssAnalysisWithElements([
			{ file: 'page.html', partialName: 'card', startLine: 5, startCol: 3, selector: '.card', ruleLine: 3 },
		]);
		const result = findElementsForSelector(ssRelPath, 0, cssAnalysis as any, [ssPath], tplRoot);
		strictEqual(result, null);
	});

	it('preserves match type', async () => {
		const cssAnalysis = makeCssAnalysisWithElements([
			{ file: 'page.html', partialName: 'card', startLine: 5, startCol: 3, selector: '.card', ruleLine: 1, matchType: 'conditional' },
		]);
		const result = findElementsForSelector(ssRelPath, 0, cssAnalysis as any, [ssPath], tplRoot);
		ok(result);
		strictEqual(result![0].matchType, 'conditional');
	});
});

describe('asset ref hover', () => {
	const assetDirs = new Map([
		['images', '/workspace/assets/images'],
		['icons', '/workspace/assets/icons'],
	]);

	it('shows resolved path for src~ attribute', async () => {
		const index = makeIndex([], []);
		const doc = makeDoc(['<img src~="@images/photo.jpg" />']);
		const result = getHover(doc, pos(0, 15), 'page.html', index, null, null, null, assetDirs);
		const v = hoverValue(result);
		ok(v.includes('**Asset**'));
		ok(v.includes('@images/photo.jpg'));
		ok(v.includes('/workspace/assets/images'));
	});

	it('shows resolved path for :src~ bind attribute', async () => {
		const index = makeIndex([], []);
		const doc = makeDoc(['<img :src~="@images/banner.png" />']);
		const result = getHover(doc, pos(0, 16), 'page.html', index, null, null, null, assetDirs);
		const v = hoverValue(result);
		ok(v.includes('**Asset**'));
		ok(v.includes('@images/banner.png'));
	});

	it('shows unknown for unrecognized asset dir', async () => {
		const index = makeIndex([], []);
		const doc = makeDoc(['<img src~="@unknown/photo.jpg" />']);
		const result = getHover(doc, pos(0, 15), 'page.html', index, null, null, null, assetDirs);
		const v = hoverValue(result);
		ok(v.includes('unknown asset directory'));
	});

	it('returns null when cursor is outside ~ attribute', async () => {
		const index = makeIndex([], []);
		const doc = makeDoc(['<img src="regular.jpg" src~="@images/photo.jpg" />']);
		const result = getHover(doc, pos(0, 12), 'page.html', index, null, null, null, assetDirs);
		strictEqual(result, null);
	});

	it('returns null when no asset dirs configured', async () => {
		const index = makeIndex([], []);
		const doc = makeDoc(['<img src~="@images/photo.jpg" />']);
		const result = getHover(doc, pos(0, 15), 'page.html', index, null, null, null, undefined);
		strictEqual(result, null);
	});

	it('shows asset hover at every position across src~="..." with CSS rules active', async () => {
		const index = makeIndex([], []);
		//                  0         1         2         3         4
		//                  0123456789012345678901234567890123456789012345
		const line =       '<img class="hero" src~="@images/photo.jpg" />';
		const doc = makeDoc([line]);
		const cssAnalysis = {
			elementMatches: new Map([['page.html', [{
				element: null, file: 'page.html', partialName: 'test',
				startLine: 1, startCol: 1, startOffset: 0,
				matches: [{
					rule: { selectorText: '.hero', selectors: ['.hero'], properties: [], mediaConditions: [], sourceLine: 1, sourceCol: 1 },
					selector: '.hero', specificity: [0, 1, 0] as [number, number, number], mediaConditions: [], matchType: 'definite',
				}],
			}]]]),
			rules: [],
		};
		// src~="@images/photo.jpg" spans characters 18..41
		// Every position from 18 to 41 should show asset hover, not CSS rules
		for (let ch = 18; ch <= 41; ch++) {
			const result = getHover(doc, pos(0, ch), 'page.html', index, cssAnalysis as any, null, null, assetDirs);
			const v = hoverValue(result);
			ok(v.includes('Asset'), `char ${ch} ('${line[ch]}'): expected asset hover, got: ${v}`);
			ok(!v.includes('CSS Rules'), `char ${ch} ('${line[ch]}'): should not show CSS rules, got: ${v}`);
		}
	});

	it('shows asset hover at every position across :src~="..." bind syntax', async () => {
		const index = makeIndex([], []);
		//                  0         1         2         3         4
		//                  01234567890123456789012345678901234567890123456
		const line =       '<img class="hero" :src~="@images/photo.jpg" />';
		const doc = makeDoc([line]);
		const cssAnalysis = {
			elementMatches: new Map([['page.html', [{
				element: null, file: 'page.html', partialName: 'test',
				startLine: 1, startCol: 1, startOffset: 0,
				matches: [{
					rule: { selectorText: '.hero', selectors: ['.hero'], properties: [], mediaConditions: [], sourceLine: 1, sourceCol: 1 },
					selector: '.hero', specificity: [0, 1, 0] as [number, number, number], mediaConditions: [], matchType: 'definite',
				}],
			}]]]),
			rules: [],
		};
		// :src~="@images/photo.jpg" spans from the : to the closing "
		const attrStr = ':src~="@images/photo.jpg"';
		const attrStart = line.indexOf(attrStr);
		const attrEnd = attrStart + attrStr.length - 1;
		for (let ch = attrStart; ch <= attrEnd; ch++) {
			const result = getHover(doc, pos(0, ch), 'page.html', index, cssAnalysis as any, null, null, assetDirs);
			const v = hoverValue(result);
			ok(v.includes('Asset'), `char ${ch} ('${line[ch]}'): expected asset hover, got: ${v}`);
			ok(!v.includes('CSS Rules'), `char ${ch} ('${line[ch]}'): should not show CSS rules, got: ${v}`);
		}
	});

	it('still shows CSS rules when hovering on class attr (not asset attr)', async () => {
		const index = makeIndex([], []);
		const line = '<img class="hero" src~="@images/photo.jpg" />';
		const doc = makeDoc([line]);
		const cssAnalysis = {
			elementMatches: new Map([['page.html', [{
				element: null, file: 'page.html', partialName: 'test',
				startLine: 1, startCol: 1, startOffset: 0,
				matches: [{
					rule: { selectorText: '.hero', selectors: ['.hero'], properties: [], mediaConditions: [], sourceLine: 1, sourceCol: 1 },
					selector: '.hero', specificity: [0, 1, 0] as [number, number, number], mediaConditions: [], matchType: 'definite',
				}],
			}]]]),
			rules: [],
		};
		// Cursor on "hero" inside class="hero" (character 12)
		const result = getHover(doc, pos(0, 12), 'page.html', index, cssAnalysis as any, null, null, assetDirs);
		const v = hoverValue(result);
		ok(v.includes('CSS Rules'), `Expected CSS rules on class attr, got: ${v}`);
	});

	it('shows asset hover when src~ comes before class', async () => {
		const index = makeIndex([], []);
		const line = '<img src~="@images/photo.jpg" class="hero" />';
		const doc = makeDoc([line]);
		const cssAnalysis = {
			elementMatches: new Map([['page.html', [{
				element: null, file: 'page.html', partialName: 'test',
				startLine: 1, startCol: 1, startOffset: 0,
				matches: [{
					rule: { selectorText: '.hero', selectors: ['.hero'], properties: [], mediaConditions: [], sourceLine: 1, sourceCol: 1 },
					selector: '.hero', specificity: [0, 1, 0] as [number, number, number], mediaConditions: [], matchType: 'definite',
				}],
			}]]]),
			rules: [],
		};
		const attrStr = 'src~="@images/photo.jpg"';
		const attrStart = line.indexOf(attrStr);
		const attrEnd = attrStart + attrStr.length - 1;
		for (let ch = attrStart; ch <= attrEnd; ch++) {
			const result = getHover(doc, pos(0, ch), 'page.html', index, cssAnalysis as any, null, null, assetDirs);
			const v = hoverValue(result);
			ok(v.includes('Asset'), `char ${ch} ('${line[ch]}'): expected asset hover, got: ${v}`);
		}
	});

	it('shows asset hover for dynamic asset :src~="expr" with no @ref', async () => {
		const index = makeIndex([], []);
		const line = '<img class="hero" :src~="file" />';
		const doc = makeDoc([line]);
		const cssAnalysis = {
			elementMatches: new Map([['page.html', [{
				element: null, file: 'page.html', partialName: 'test',
				startLine: 1, startCol: 1, startOffset: 0,
				matches: [{
					rule: { selectorText: '.hero', selectors: ['.hero'], properties: [], mediaConditions: [], sourceLine: 1, sourceCol: 1 },
					selector: '.hero', specificity: [0, 1, 0] as [number, number, number], mediaConditions: [], matchType: 'definite',
				}],
			}]]]),
			rules: [],
		};
		// Cursor on the attribute name (:src~)
		const attrStr = ':src~="file"';
		const attrStart = line.indexOf(attrStr);
		const result = getHover(doc, pos(0, attrStart + 1), 'page.html', index, cssAnalysis as any, null, null, assetDirs);
		const v = hoverValue(result);
		ok(v.includes('Asset'), `Expected asset hover, got: ${v}`);
		ok(!v.includes('CSS Rules'), `Should not show CSS rules, got: ${v}`);
	});

	it('shows asset hover with single-quoted attributes', async () => {
		const index = makeIndex([], []);
		const line = "<img class='hero' src~='@images/photo.jpg' />";
		const doc = makeDoc([line]);
		const cssAnalysis = {
			elementMatches: new Map([['page.html', [{
				element: null, file: 'page.html', partialName: 'test',
				startLine: 1, startCol: 1, startOffset: 0,
				matches: [{
					rule: { selectorText: '.hero', selectors: ['.hero'], properties: [], mediaConditions: [], sourceLine: 1, sourceCol: 1 },
					selector: '.hero', specificity: [0, 1, 0] as [number, number, number], mediaConditions: [], matchType: 'definite',
				}],
			}]]]),
			rules: [],
		};
		const attrStr = "src~='@images/photo.jpg'";
		const attrStart = line.indexOf(attrStr);
		const attrEnd = attrStart + attrStr.length - 1;
		for (let ch = attrStart; ch <= attrEnd; ch++) {
			const result = getHover(doc, pos(0, ch), 'page.html', index, cssAnalysis as any, null, null, assetDirs);
			const v = hoverValue(result);
			ok(v.includes('Asset'), `char ${ch} ('${line[ch]}'): expected asset hover, got: ${v}`);
			ok(!v.includes('CSS Rules'), `char ${ch} ('${line[ch]}'): should not show CSS rules, got: ${v}`);
		}
	});

	it('shows resolved path for single-quoted src~ attribute', async () => {
		const index = makeIndex([], []);
		const doc = makeDoc(["<img src~='@images/photo.jpg' />"]);
		const result = getHover(doc, pos(0, 15), 'page.html', index, null, null, null, assetDirs);
		const v = hoverValue(result);
		ok(v.includes('**Asset**'));
		ok(v.includes('@images/photo.jpg'));
		ok(v.includes('/workspace/assets/images'));
	});
});
