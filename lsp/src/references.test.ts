import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { findReferences, parseAssetRefAtCursor, findAssetReferences } from './references.js';
import { makeLoc, makeIndex } from './test-helpers.js';

describe('findReferences', () => {
	const root = '/workspace';

	it('finds same-file references', () => {
		const index = makeIndex(
			[{ file: 'page.html', name: 'card', loc: makeLoc(1, 1, 1, 10), exported: false }],
			[{ file: 'page.html', partialName: 'card', targetFile: null, loc: makeLoc(5, 10, 5, 30) }],
		);
		const result = findReferences('card', 'page.html', index, root);
		deepStrictEqual(result, [{
			uri: 'file:///workspace/page.html',
			range: {
				start: { line: 4, character: 9 },
				end: { line: 4, character: 29 },
			},
		}]);
	});

	it('finds cross-file references', () => {
		const index = makeIndex(
			[{ file: 'components.html', name: 'card', loc: makeLoc(1, 1, 1, 10), exported: true }],
			[{ file: 'page.html', partialName: 'card', targetFile: 'components.html', loc: makeLoc(3, 5, 3, 40) }],
		);
		const result = findReferences('card', 'components.html', index, root);
		deepStrictEqual(result, [{
			uri: 'file:///workspace/page.html',
			range: {
				start: { line: 2, character: 4 },
				end: { line: 2, character: 39 },
			},
		}]);
	});

	it('returns empty array when no references match', () => {
		const index = makeIndex(
			[{ file: 'page.html', name: 'card', loc: makeLoc(1, 1, 1, 10), exported: false }],
			[{ file: 'page.html', partialName: 'other', targetFile: null, loc: makeLoc(5, 10, 5, 30) }],
		);
		const result = findReferences('card', 'page.html', index, root);
		deepStrictEqual(result, []);
	});
});

describe('parseAssetRefAtCursor', () => {
	it('parses @name/subpath from src~ attribute', () => {
		const line = '<img src~="@images/photo.jpg" />';
		const result = parseAssetRefAtCursor(line, 15);
		deepStrictEqual(result, { name: 'images', subpath: 'photo.jpg' });
	});

	it('parses @name/subpath from :src~ bind attribute', () => {
		const line = '<img :src~="@icons/arrow.svg" />';
		const result = parseAssetRefAtCursor(line, 16);
		deepStrictEqual(result, { name: 'icons', subpath: 'arrow.svg' });
	});

	it('parses subpath with subdirectories', () => {
		const line = '<img src~="@images/sub/dir/photo.jpg" />';
		const result = parseAssetRefAtCursor(line, 20);
		deepStrictEqual(result, { name: 'images', subpath: 'sub/dir/photo.jpg' });
	});

	it('returns null when cursor is outside ~ attribute', () => {
		const line = '<img src="normal.jpg" />';
		const result = parseAssetRefAtCursor(line, 12);
		strictEqual(result, null);
	});

	it('returns null when cursor is outside value range', () => {
		const line = '<img src~="@images/photo.jpg" class="x" />';
		const result = parseAssetRefAtCursor(line, 35);
		strictEqual(result, null);
	});
});

describe('findAssetReferences', () => {
	it('finds all references to an asset across files', () => {
		const templateFiles = new Map([
			['page.html', '<img src~="@images/photo.jpg" />\n<img src~="@images/photo.jpg" />'],
			['other.html', '<img src~="@images/other.jpg" />'],
		]);
		const result = findAssetReferences('images', 'photo.jpg', templateFiles, '/workspace');
		deepStrictEqual(result.length, 2);
		deepStrictEqual(result[0].uri, 'file:///workspace/page.html');
		deepStrictEqual(result[0].range.start.line, 0);
		deepStrictEqual(result[1].uri, 'file:///workspace/page.html');
		deepStrictEqual(result[1].range.start.line, 1);
	});

	it('finds references across multiple files', () => {
		const templateFiles = new Map([
			['page.html', '<img src~="@images/logo.png" />'],
			['header.html', '<img src~="@images/logo.png" />'],
		]);
		const result = findAssetReferences('images', 'logo.png', templateFiles, '/workspace');
		deepStrictEqual(result.length, 2);
		deepStrictEqual(result[0].uri, 'file:///workspace/page.html');
		deepStrictEqual(result[1].uri, 'file:///workspace/header.html');
	});

	it('returns empty when no matches', () => {
		const templateFiles = new Map([
			['page.html', '<img src~="@images/other.jpg" />'],
		]);
		const result = findAssetReferences('images', 'photo.jpg', templateFiles, '/workspace');
		deepStrictEqual(result, []);
	});

	it('parses single-quoted ~ attribute at cursor', () => {
		const line = "<img src~='@images/photo.jpg' />";
		const result = parseAssetRefAtCursor(line, 15);
		ok(result !== null, 'expected a parsed asset ref');
		deepStrictEqual(result!.name, 'images');
		deepStrictEqual(result!.subpath, 'photo.jpg');
	});

	it('only matches inside ~ attributes', () => {
		const templateFiles = new Map([
			['page.html', '<img src="@images/photo.jpg" />'],
		]);
		const result = findAssetReferences('images', 'photo.jpg', templateFiles, '/workspace');
		deepStrictEqual(result, []);
	});
});
