import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { buildIndex } from './index.js';
import { findDefinition } from './definition.js';
import { getDocumentSymbols } from './symbols.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
// Runs against the built @backflip/html dist (like the LSP server itself);
// rebuild the root package (`npm run build`) after compiler changes.
import { compileDirectory } from '@backflip/html';
import type { CompiledDirectory, RootTNode, PartialRefTNode, SlotTNode, SourceLoc } from '@backflip/html';

function makeLoc(startLine: number, startCol: number, endLine: number, endCol: number): SourceLoc {
	return { startLine, startCol, startOffset: 0, endLine, endCol, endOffset: 0 };
}

function makeRoot(tnodes: any[], loc?: SourceLoc, opts?: { exported?: boolean }): RootTNode {
	return { tnodes, loc, exported: opts?.exported } as RootTNode;
}

function makeSlot(name?: string): SlotTNode {
	return { type: 'slot', name } as SlotTNode;
}

function makePartialRef(partialName: string, file: string | null, loc?: SourceLoc, opts?: { bindings?: { kind: 'expr', name: string, data: any }[], slots?: Record<string, any[]> }): PartialRefTNode {
	return {
		type: 'partial-ref',
		kind: 'b-part',
		partialName,
		file,
		slots: opts?.slots ?? {},
		bindings: opts?.bindings ?? [],
		loc,
	} as PartialRefTNode;
}

describe('buildIndex', () => {
	it('indexes partial definitions', () => {
		const loc = makeLoc(1, 1, 1, 20);
		const dir: CompiledDirectory = {
			files: new Map([
				['page.html', { partials: new Map([['header', makeRoot([], loc)]]) }],
			]),
		};

		const index = buildIndex(dir);
		strictEqual(index.partialDefs.size, 1);
		const defs = index.partialDefs.get('header')!;
		strictEqual(defs.length, 1);
		strictEqual(defs[0].file, 'page.html');
		strictEqual(defs[0].name, 'header');
		deepStrictEqual(defs[0].loc, loc);
	});

	it('collects partial references from tnodes', () => {
		const refLoc = makeLoc(5, 10, 5, 30);
		const ref = makePartialRef('card', null, refLoc);
		const dir: CompiledDirectory = {
			files: new Map([
				['page.html', { partials: new Map([['main', makeRoot([ref])]]) }],
			]),
		};

		const index = buildIndex(dir);
		strictEqual(index.partialRefs.length, 1);
		strictEqual(index.partialRefs[0].partialName, 'card');
		strictEqual(index.partialRefs[0].file, 'page.html');
		strictEqual(index.partialRefs[0].targetFile, null);
	});

	it('collects cross-file references', () => {
		const ref = makePartialRef('card', 'components.html', makeLoc(3, 5, 3, 40));
		const dir: CompiledDirectory = {
			files: new Map([
				['page.html', { partials: new Map([['main', makeRoot([ref])]]) }],
			]),
		};

		const index = buildIndex(dir);
		strictEqual(index.partialRefs[0].targetFile, 'components.html');
	});

	it('indexes multiple files and partials', () => {
		const dir: CompiledDirectory = {
			files: new Map([
				['a.html', { partials: new Map([
					['header', makeRoot([], makeLoc(1, 1, 1, 10))],
					['footer', makeRoot([], makeLoc(5, 1, 5, 10))],
				]) }],
				['b.html', { partials: new Map([
					['card', makeRoot([], makeLoc(1, 1, 1, 15))],
				]) }],
			]),
		};

		const index = buildIndex(dir);
		strictEqual(index.partialDefs.size, 3);
		strictEqual(index.partialDefs.get('header')!.length, 1);
		strictEqual(index.partialDefs.get('footer')!.length, 1);
		strictEqual(index.partialDefs.get('card')!.length, 1);
	});

	it('reads exported and computes freeVars from RootTNode', () => {
		const dir: CompiledDirectory = {
			files: new Map([
				['page.html', { partials: new Map([
					['card', makeRoot([], makeLoc(1, 1, 1, 20), { exported: true })],
				]) }],
			]),
		};

		const index = buildIndex(dir);
		const def = index.partialDefs.get('card')![0];
		strictEqual(def.exported, true);
		deepStrictEqual(def.freeVars, []);
	});

	it('defaults exported to false and freeVars to empty', () => {
		const dir: CompiledDirectory = {
			files: new Map([
				['page.html', { partials: new Map([
					['card', makeRoot([], makeLoc(1, 1, 1, 20))],
				]) }],
			]),
		};

		const index = buildIndex(dir);
		const def = index.partialDefs.get('card')![0];
		strictEqual(def.exported, false);
		deepStrictEqual(def.freeVars, []);
	});

	it('collects slot names from partial tree', () => {
		const dir: CompiledDirectory = {
			files: new Map([
				['page.html', { partials: new Map([
					['card', makeRoot([makeSlot('header'), makeSlot(undefined), makeSlot('footer')], makeLoc(1, 1, 1, 20))],
				]) }],
			]),
		};

		const index = buildIndex(dir);
		const def = index.partialDefs.get('card')![0];
		deepStrictEqual(def.slots, ['header', 'default', 'footer']);
	});

	it('indexes file-relative locs for partials after the first in a file', async () => {
		// Regression test: compileDirectory used to emit slice-relative
		// locations, so go-to-definition for any partial after the first in a
		// file pointed at the top of the file.
		const dir = path.join('/tmp/claude-1000', `lsp_index_filerel_${Date.now()}`);
		await fs.mkdir(dir, { recursive: true });
		try {
			const html = [
				'<div b-name="first">',   // line 1
				'  <p>hello</p>',
				'</div>',
				'<div b-name="second">',  // line 4
				'  <p>world</p>',
				'</div>',
			].join('\n');
			await fs.writeFile(path.join(dir, 'page.html'), html, 'utf-8');

			const { directory } = await compileDirectory(dir);
			const index = buildIndex(directory as CompiledDirectory);

			const defs = index.partialDefs.get('second')!;
			strictEqual(defs.length, 1);
			strictEqual(defs[0].loc!.startLine, 4);

			const result = findDefinition('second', null, 'page.html', index, '/workspace');
			// LSP ranges are 0-based: line 4 in the file is range line 3.
			strictEqual(result!.range.start.line, 3);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it('collects dataBindings and slotsFilled from refs', () => {
		const ref = makePartialRef('card', null, makeLoc(5, 10, 5, 30), {
			bindings: [
				{ kind: 'expr', name: 'title', data: { vars: [], errs: [], expr: undefined } },
				{ kind: 'expr', name: 'items', data: { vars: [], errs: [], expr: undefined } },
			],
			slots: { 'default': [], 'header': [] },
		});
		const dir: CompiledDirectory = {
			files: new Map([
				['page.html', { partials: new Map([['main', makeRoot([ref])]]) }],
			]),
		};

		const index = buildIndex(dir);
		deepStrictEqual(index.partialRefs[0].dataBindings, ['title', 'items']);
		deepStrictEqual(index.partialRefs[0].slotsFilled, ['default', 'header']);
	});
});

describe('buildIndex — partial extents', () => {
	const HTML = [
		'<div b-name="first">',       // line 1
		'  <p>hello</p>',             // line 2
		'  <p>still first</p>',       // line 3
		'</div>',                     // line 4
		'<my-widget b-attr:label>',   // line 5
		'  <b>{{ label }}</b>',       // line 6
		'</my-widget>',               // line 7
	].join('\n');

	async function compiled(): Promise<{ index: ReturnType<typeof buildIndex>; html: string }> {
		const dir = path.join('/tmp/claude-1000', `lsp_index_extent_${Date.now()}_${Math.random().toString(36).slice(2)}`);
		await fs.mkdir(dir, { recursive: true });
		try {
			await fs.writeFile(path.join(dir, 'page.html'), HTML, 'utf-8');
			const { directory } = await compileDirectory(dir);
			return { index: buildIndex(directory as CompiledDirectory), html: HTML };
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}

	it('records the full file-relative extent of every partial', async () => {
		const { index, html } = await compiled();

		const first = index.partialDefs.get('first')![0];
		strictEqual(first.extent!.startOffset, 0);
		strictEqual(html.slice(first.extent!.startOffset, first.extent!.endOffset).endsWith('</div>'), true);

		// The second partial is compiled from a slice, so its offsets must be
		// rebased to the whole file rather than starting at 0 again.
		const widget = index.partialDefs.get('my-widget')![0];
		strictEqual(widget.extent!.startOffset, html.indexOf('<my-widget'));
		strictEqual(html.slice(widget.extent!.startOffset, widget.extent!.endOffset), [
			'<my-widget b-attr:label>',
			'  <b>{{ label }}</b>',
			'</my-widget>',
		].join('\n'));
	});

	it('produces symbol ranges that contain every line of their partial', async () => {
		// The bug: `range` was the b-name attribute span, so it covered only the
		// definition line. The extension finds the partial under the cursor by
		// testing the cursor line against this range (Preview Partial), and the
		// outline/breadcrumbs use it too — both worked on one line per partial.
		const { index, html } = await compiled();
		const doc = TextDocument.create('file:///page.html', 'html', 1, html);
		const symbols = getDocumentSymbols('page.html', index, doc);

		const partialAtLine = (line0: number) =>
			symbols.find(s => line0 >= s.range.start.line && line0 <= s.range.end.line)?.name ?? null;

		strictEqual(partialAtLine(0), 'first');
		strictEqual(partialAtLine(1), 'first');
		strictEqual(partialAtLine(2), 'first');
		strictEqual(partialAtLine(3), 'first');
		strictEqual(partialAtLine(4), 'my-widget');
		strictEqual(partialAtLine(5), 'my-widget');
		strictEqual(partialAtLine(6), 'my-widget');
	});

	it('keeps selectionRange on the definition name and inside range', async () => {
		const { index, html } = await compiled();
		const doc = TextDocument.create('file:///page.html', 'html', 1, html);
		const symbols = getDocumentSymbols('page.html', index, doc);

		for (const sym of symbols) {
			const { range: r, selectionRange: sr } = sym;
			strictEqual(r.start.line <= sr.start.line, true, `${sym.name}: selectionRange starts before range`);
			strictEqual(r.end.line >= sr.end.line, true, `${sym.name}: selectionRange ends after range`);
		}

		// `first` is a b-name partial: the name range is the attribute itself.
		const first = symbols.find(s => s.name === 'first')!;
		strictEqual(doc.getText(first.selectionRange), 'b-name="first"');
	});
});
