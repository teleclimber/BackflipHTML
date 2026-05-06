import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { findDefinition, findAssetDefinition, findCustomElementDefinition } from './definition.js';
import { makeLoc, makeIndex } from './test-helpers.js';

describe('findDefinition', () => {
	const root = '/workspace';

	it('finds same-file definition when targetFile is null', () => {
		const index = makeIndex(
			[{ file: 'page.html', name: 'header', loc: makeLoc(2, 5, 2, 30), exported: false }],
			[],
		);
		const result = findDefinition('header', null, 'page.html', index, root);
		deepStrictEqual(result, {
			uri: 'file:///workspace/page.html',
			range: {
				start: { line: 1, character: 4 },
				end: { line: 1, character: 29 },
			},
		});
	});

	it('finds cross-file definition', () => {
		const index = makeIndex(
			[{ file: 'components.html', name: 'card', loc: makeLoc(1, 1, 1, 20), exported: true }],
			[],
		);
		const result = findDefinition('card', 'components.html', 'page.html', index, root);
		deepStrictEqual(result, {
			uri: 'file:///workspace/components.html',
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 19 },
			},
		});
	});

	it('returns null for unknown partial', () => {
		const index = makeIndex([], []);
		const result = findDefinition('nonexistent', null, 'page.html', index, root);
		strictEqual(result, null);
	});

	it('returns null when partial exists in different file', () => {
		const index = makeIndex(
			[{ file: 'other.html', name: 'header', loc: makeLoc(1, 1, 1, 10), exported: false }],
			[],
		);
		const result = findDefinition('header', null, 'page.html', index, root);
		strictEqual(result, null);
	});

	it('matches correct file when multiple defs exist', () => {
		const index = makeIndex(
			[
				{ file: 'a.html', name: 'card', loc: makeLoc(1, 1, 1, 10), exported: false },
				{ file: 'b.html', name: 'card', loc: makeLoc(3, 5, 3, 25), exported: true },
			],
			[],
		);
		const result = findDefinition('card', 'b.html', 'page.html', index, root);
		deepStrictEqual(result, {
			uri: 'file:///workspace/b.html',
			range: {
				start: { line: 2, character: 4 },
				end: { line: 2, character: 24 },
			},
		});
	});
});

describe('findCustomElementDefinition', () => {
	const root = '/workspace';

	it('finds the definition of a custom element partial in any file', () => {
		const index = makeIndex(
			[{
				file: 'components.html', name: 'my-card',
				loc: makeLoc(1, 1, 1, 9), exported: true, customElement: true,
			}],
			[],
		);
		const result = findCustomElementDefinition('my-card', index, root);
		deepStrictEqual(result, {
			uri: 'file:///workspace/components.html',
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 8 },
			},
		});
	});

	it('returns null for unknown custom element', () => {
		const index = makeIndex([], []);
		const result = findCustomElementDefinition('my-card', index, root);
		strictEqual(result, null);
	});

	it('skips non-customElement partials with the same name', () => {
		const index = makeIndex(
			[{
				file: 'page.html', name: 'my-thing',
				loc: makeLoc(1, 1, 1, 12), exported: false, customElement: false,
			}],
			[],
		);
		const result = findCustomElementDefinition('my-thing', index, root);
		strictEqual(result, null);
	});
});

describe('findAssetDefinition', () => {
	const assetDirs = new Map([
		['images', '/workspace/assets/images'],
		['icons', '/workspace/assets/icons'],
	]);

	it('resolves src~ to file path', () => {
		const line = '<img src~="@images/photo.jpg" />';
		const result = findAssetDefinition(line, 15, assetDirs);
		deepStrictEqual(result, {
			uri: 'file:///workspace/assets/images/photo.jpg',
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
		});
	});

	it('resolves :src~ bind attribute', () => {
		const line = '<img :src~="@icons/arrow.svg" />';
		const result = findAssetDefinition(line, 16, assetDirs);
		deepStrictEqual(result, {
			uri: 'file:///workspace/assets/icons/arrow.svg',
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
		});
	});

	it('resolves subpath with directories', () => {
		const line = '<img src~="@images/sub/dir/photo.jpg" />';
		const result = findAssetDefinition(line, 20, assetDirs);
		deepStrictEqual(result, {
			uri: 'file:///workspace/assets/images/sub/dir/photo.jpg',
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
		});
	});

	it('returns null for unknown asset dir', () => {
		const line = '<img src~="@unknown/photo.jpg" />';
		const result = findAssetDefinition(line, 15, assetDirs);
		strictEqual(result, null);
	});

	it('returns null when cursor is outside ~ attribute', () => {
		const line = '<img src="normal.jpg" src~="@images/photo.jpg" />';
		const result = findAssetDefinition(line, 12, assetDirs);
		strictEqual(result, null);
	});

	it('returns null for non-~ attribute', () => {
		const line = '<img src="@images/photo.jpg" />';
		const result = findAssetDefinition(line, 15, assetDirs);
		strictEqual(result, null);
	});

	it('resolves single-quoted src~ attribute', () => {
		const line = "<img src~='@images/photo.jpg' />";
		const result = findAssetDefinition(line, 15, assetDirs);
		ok(result !== null, 'expected a definition');
		ok(result!.uri.includes('/workspace/assets/images/photo.jpg'));
	});
});
