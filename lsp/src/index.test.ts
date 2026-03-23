import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert';
import { buildIndex } from './index.js';
import type { CompiledDirectory, RootTNode, PartialRefTNode, SlotTNode, SourceLoc } from '@backflip/html';

function makeLoc(startLine: number, startCol: number, endLine: number, endCol: number): SourceLoc {
	return { startLine, startCol, startOffset: 0, endLine, endCol, endOffset: 0 };
}

function makeRoot(tnodes: any[], loc?: SourceLoc, opts?: { exported?: boolean, freeVars?: string[] }): RootTNode {
	return { tnodes, loc, exported: opts?.exported, freeVars: opts?.freeVars } as RootTNode;
}

function makeSlot(name?: string): SlotTNode {
	return { type: 'slot', name, parent: {} as any } as SlotTNode;
}

function makePartialRef(partialName: string, file: string | null, loc?: SourceLoc, opts?: { bindings?: { name: string, data: any }[], slots?: Record<string, any[]> }): PartialRefTNode {
	return {
		type: 'partial-ref',
		partialName,
		file,
		wrapper: null,
		slots: opts?.slots ?? {},
		bindings: opts?.bindings ?? [],
		loc,
		parent: {} as any,
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

	it('reads exported and freeVars from RootTNode', () => {
		const dir: CompiledDirectory = {
			files: new Map([
				['page.html', { partials: new Map([
					['card', makeRoot([], makeLoc(1, 1, 1, 20), { exported: true, freeVars: ['title', 'items'] })],
				]) }],
			]),
		};

		const index = buildIndex(dir);
		const def = index.partialDefs.get('card')![0];
		strictEqual(def.exported, true);
		deepStrictEqual(def.freeVars, ['title', 'items']);
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

	it('collects dataBindings and slotsFilled from refs', () => {
		const ref = makePartialRef('card', null, makeLoc(5, 10, 5, 30), {
			bindings: [
				{ name: 'title', data: { vars: [], errs: [], expr: undefined } },
				{ name: 'items', data: { vars: [], errs: [], expr: undefined } },
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
