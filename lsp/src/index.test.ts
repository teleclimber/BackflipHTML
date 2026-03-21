import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert';
import { buildIndex } from './index.js';
import type { CompiledDirectory, RootTNode, PartialRefTNode, SourceLoc } from '@backflip/html';

function makeLoc(startLine: number, startCol: number, endLine: number, endCol: number): SourceLoc {
	return { startLine, startCol, startOffset: 0, endLine, endCol, endOffset: 0 };
}

function makeRoot(tnodes: any[], loc?: SourceLoc): RootTNode {
	return { tnodes, loc } as RootTNode;
}

function makePartialRef(partialName: string, file: string | null, loc?: SourceLoc): PartialRefTNode {
	return {
		type: 'partial-ref',
		partialName,
		file,
		wrapper: null,
		slots: {},
		bindings: [],
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
});
