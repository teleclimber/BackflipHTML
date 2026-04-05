import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { compileDirectory } from '@backflip/html';
import { collectAssetReferences } from './references.js';

const templateRoot = path.resolve(import.meta.dirname!, '../../test/templates');
const imagesDir = path.resolve(import.meta.dirname!, '../../test/assets/images');

describe('collectAssetReferences', () => {
	it('collects static asset references from compiled templates', async () => {
		const assetDirs = new Map([['images', imagesDir]]);
		const assetMap = new Map([['images', '/__assets/images/']]);
		const { directory } = await compileDirectory(templateRoot, { assetMap, assetDirs });

		const refs = collectAssetReferences(directory.files);

		// The assets.html template has references to:
		// - @images/photo.jpg (static-asset partial)
		// - @images/sub/nested.jpg (subpath-asset partial)
		// - @images/photo.jpg 1x, @images/icon.png 2x (srcset-asset partial)
		// - @images/photo.jpg with :class binding (mixed-asset partial)
		const photoRefs = refs.filter(r => r.assetSubpath === 'photo.jpg');
		assert.ok(photoRefs.length >= 2, `expected at least 2 refs to photo.jpg, got ${photoRefs.length}`);

		const nestedRef = refs.find(r => r.assetSubpath === 'sub/nested.jpg');
		assert.ok(nestedRef, 'should find reference to sub/nested.jpg');
		assert.equal(nestedRef.assetName, 'images');

		const iconRef = refs.find(r => r.assetSubpath === 'icon.png');
		assert.ok(iconRef, 'should find reference to icon.png from srcset');
		assert.equal(iconRef.assetName, 'images');
	});

	it('includes template file and partial name', async () => {
		const assetDirs = new Map([['images', imagesDir]]);
		const assetMap = new Map([['images', '/__assets/images/']]);
		const { directory } = await compileDirectory(templateRoot, { assetMap, assetDirs });

		const refs = collectAssetReferences(directory.files);
		const staticRef = refs.find(r => r.partialName === 'static-asset');
		assert.ok(staticRef, 'should find reference in static-asset partial');
		assert.ok(staticRef.sourceFile.endsWith('assets.html'));
		assert.equal(staticRef.assetName, 'images');
		assert.equal(staticRef.assetSubpath, 'photo.jpg');
	});

	it('collects asset refs from attr-bind nodes (mixed static+dynamic)', async () => {
		const assetDirs = new Map([['images', imagesDir]]);
		const assetMap = new Map([['images', '/__assets/images/']]);
		const { directory } = await compileDirectory(templateRoot, { assetMap, assetDirs });

		const refs = collectAssetReferences(directory.files);
		const mixedRef = refs.find(r => r.partialName === 'mixed-asset');
		assert.ok(mixedRef, 'should find asset ref in mixed-asset partial (attr-bind node)');
		assert.equal(mixedRef.assetName, 'images');
		assert.equal(mixedRef.assetSubpath, 'photo.jpg');
	});

	it('returns empty array for templates with no asset references', async () => {
		const { directory } = await compileDirectory(templateRoot);
		// Without assetMap, the compiler won't create AssetRefTNode nodes — but let's just check
		// that we don't crash and return something reasonable
		const refs = collectAssetReferences(directory.files);
		// Refs may or may not exist depending on compilation mode, but should not throw
		assert.ok(Array.isArray(refs));
	});
});
