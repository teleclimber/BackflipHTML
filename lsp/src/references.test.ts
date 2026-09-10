import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { compileDirectory } from '@backflip/html';
import { collectAllAssetReferences } from '@backflip/assets';
import type { AssetReference } from '@backflip/assets';
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
	const templateRoot = '/workspace';
	const assetDirs = new Map([['images', '/workspace/assets/images']]);

	function templateRef(over: Partial<AssetReference> = {}): AssetReference {
		return {
			sourceFile: 'page.html', partialName: 'card',
			line: 2, column: 16, endLine: 2, endColumn: 33,
			assetName: 'images', assetSubpath: 'photo.jpg',
			...over,
		};
	}

	it('matches the asset exactly, not by substring', () => {
		const refs = [
			templateRef(),
			templateRef({ assetSubpath: 'photo.jpg.bak', line: 3 }),
			templateRef({ assetSubpath: 'photo.jpg2', line: 4 }),
			templateRef({ assetSubpath: 'sub/photo.jpg', line: 5 }),
			templateRef({ assetName: 'icons', line: 6 }),
		];
		const result = findAssetReferences('images', 'photo.jpg', refs, templateRoot, assetDirs);
		strictEqual(result.length, 1);
		strictEqual(result[0].range.start.line, 1);
	});

	it('resolves a template reference against the template root, with its full span', () => {
		const result = findAssetReferences('images', 'photo.jpg', [templateRef()], templateRoot, assetDirs);
		deepStrictEqual(result, [{
			uri: 'file:///workspace/page.html',
			range: {
				start: { line: 1, character: 15 },
				end: { line: 1, character: 32 },
			},
		}]);
	});

	it('resolves a stylesheet reference against its asset directory', () => {
		// CSS references carry no partialName; their sourceFile is relative to
		// the asset dir the stylesheet lives in, not the template root.
		const cssRef: AssetReference = {
			sourceFile: 'css/site.css',
			line: 7, column: 12,
			assetName: 'images', assetSubpath: 'photo.jpg',
		};
		const result = findAssetReferences('images', 'photo.jpg', [cssRef], templateRoot, assetDirs);
		strictEqual(result.length, 1);
		strictEqual(result[0].uri, 'file:///workspace/assets/images/css/site.css');
	});

	it('gives a zero-width range when the reference has no end position', () => {
		// css-tree reports where a url starts and nothing more.
		const cssRef: AssetReference = {
			sourceFile: 'css/site.css', line: 7, column: 12,
			assetName: 'images', assetSubpath: 'photo.jpg',
		};
		const result = findAssetReferences('images', 'photo.jpg', [cssRef], templateRoot, assetDirs);
		deepStrictEqual(result[0].range, {
			start: { line: 6, character: 11 },
			end: { line: 6, character: 11 },
		});
	});

	it('skips references that carry no source position', () => {
		// b-script entries are collected with line 0: they name an asset but
		// have no span to jump to.
		const refs = [templateRef({ line: 0, column: 0, endLine: undefined, endColumn: undefined })];
		deepStrictEqual(findAssetReferences('images', 'photo.jpg', refs, templateRoot, assetDirs), []);
	});

	it('skips a stylesheet reference whose asset directory is unknown', () => {
		const cssRef: AssetReference = {
			sourceFile: 'css/site.css', line: 7, column: 12,
			assetName: 'images', assetSubpath: 'photo.jpg',
		};
		deepStrictEqual(findAssetReferences('images', 'photo.jpg', [cssRef], templateRoot, new Map()), []);
	});

	it('returns empty when nothing references the asset', () => {
		deepStrictEqual(findAssetReferences('images', 'missing.jpg', [templateRef()], templateRoot, assetDirs), []);
	});
});

describe('findAssetReferences — against compiled templates', () => {
	// The text scanner this replaced matched raw source, so it reported
	// references that were not references and missed ones that were. Each case
	// below is one of those; they are answered from the compiled tree now.
	const TEMPLATE = [
		'<div b-name="real">',                                   // 1
		'    <img src~="@images/photo.jpg" />',                  // 2
		'</div>',                                                // 3
		'<div b-name="lookalike">',                              // 4
		'    <img src~="@images/photo.jpg.bak" />',              // 5
		'</div>',                                                // 6
		'<div b-name="text-content">',                           // 7
		'    <img alt~="@images/icon.png" /> @images/photo.jpg', // 8
		'</div>',                                                // 9
		'<div b-name="commented">',                              // 10
		'    <!-- <img src~="@images/photo.jpg" /> -->',         // 11
		'</div>',                                                // 12
		'<div b-name="split-attr">',                             // 13
		'    <img',                                              // 14
		'        src~=',                                         // 15
		'            "@images/photo.jpg"',                       // 16
		'    />',                                                // 17
		'</div>',                                                // 18
		'<div b-name="srcset">',                                 // 19
		'    <img srcset~="@images/photo.jpg 1x, @images/icon.png 2x" />', // 20
		'</div>',                                                // 21
	].join('\n');

	async function locate(subpath: string) {
		const dir = path.join('/tmp/claude-1000', `lsp_assetrefs_${Date.now()}_${Math.random().toString(36).slice(2)}`);
		const imagesDir = path.join(dir, 'assets', 'images');
		await fs.mkdir(imagesDir, { recursive: true });
		try {
			await fs.writeFile(path.join(dir, 'page.html'), TEMPLATE, 'utf-8');
			for (const name of ['photo.jpg', 'photo.jpg.bak', 'icon.png']) {
				await fs.writeFile(path.join(imagesDir, name), '', 'utf-8');
			}
			// A stylesheet in the asset dir that uses the same image.
			await fs.writeFile(path.join(imagesDir, 'site.css'), '.hero { background: url(photo.jpg); }', 'utf-8');
			const assetDirs = new Map([['images', imagesDir]]);
			const assetMap = new Map([['images', '/__assets/images/']]);
			const { directory } = await compileDirectory(dir, { assetMap, assetDirs });
			const refs = collectAllAssetReferences(directory.files, assetDirs);
			return findAssetReferences('images', subpath, refs, dir, assetDirs);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}

	/** Lines within page.html that were reported, 1-based. */
	async function templateLines(subpath: string): Promise<number[]> {
		const hits = await locate(subpath);
		return hits.filter(l => l.uri.endsWith('page.html'))
			.map(l => l.range.start.line + 1)
			.sort((a, b) => a - b);
	}

	it('finds every real reference in the template and nothing else', async () => {
		// Line 2 (plain), line 16 (attribute split across lines), line 20 (srcset).
		// NOT line 5 (photo.jpg.bak), line 8 (bare text), or line 11 (comment).
		deepStrictEqual(await templateLines('photo.jpg'), [2, 16, 20]);
	});

	it('does not report a longer asset path that merely starts with the query', async () => {
		strictEqual((await templateLines('photo.jpg')).includes(5), false, 'photo.jpg.bak is a different asset');
	});

	it('does not report an asset path written in text content', async () => {
		strictEqual((await templateLines('photo.jpg')).includes(8), false, 'text content is not a reference');
	});

	it('does not report an asset path inside an HTML comment', async () => {
		strictEqual((await templateLines('photo.jpg')).includes(11), false, 'a commented-out tag is not a reference');
	});

	it('finds a reference whose attribute name and value are on different lines', async () => {
		strictEqual((await templateLines('photo.jpg')).includes(16), true, 'the tree knows the attribute the scanner could not see');
	});

	it('finds both references on a srcset line, spanning each one', async () => {
		const photo = (await locate('photo.jpg')).filter(l => l.uri.endsWith('page.html') && l.range.start.line === 19);
		const icon = (await locate('icon.png')).filter(l => l.uri.endsWith('page.html') && l.range.start.line === 19);
		strictEqual(photo.length, 1);
		strictEqual(icon.length, 1);
		// Distinct, non-overlapping spans within the one attribute value.
		strictEqual(photo[0].range.end.character <= icon[0].range.start.character, true);
	});

	it('reports a stylesheet url for the same asset', async () => {
		// site.css uses photo.jpg through a plain `url(...)`, which is a real
		// use of the asset and belongs in the list alongside the template ones.
		const hits = await locate('photo.jpg');
		const css = hits.filter(l => l.uri.endsWith('site.css'));
		strictEqual(css.length, 1, `expected one stylesheet hit, got ${hits.map(l => l.uri).join(', ')}`);
		strictEqual(css[0].range.start.line, 0);
		// css-tree gives only the start of a url, so the location is a caret.
		deepStrictEqual(css[0].range.start, css[0].range.end);
	});

	it('spans the whole @name/subpath reference in a template', async () => {
		const first = (await locate('photo.jpg')).find(l => l.uri.endsWith('page.html'))!;
		strictEqual(first.range.start.line, 1);
		// `    <img src~="@images/photo.jpg" />` — the span covers @images/photo.jpg
		strictEqual(first.range.start.character, 15);
		strictEqual(first.range.end.character, 15 + '@images/photo.jpg'.length);
	});
});
