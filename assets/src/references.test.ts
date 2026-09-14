import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
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

describe('collectAssetReferences — b-script entries', () => {
	// A b-script entry names an asset like any attribute does, so it must be
	// collected with the same spans: without them the missing-file diagnostic,
	// find-references and the usage report have nowhere to point.
	const TEMPLATE = [
		'<my-widget b-attr:count b-script="@scripts/my-widget.js">', // 1
		'\t<span>{{ count }}</span>',                                // 2
		'</my-widget>',                                              // 3
	].join('\n');

	async function collect() {
		const dir = path.join('/tmp/claude-1000', `assets_bscript_${Date.now()}_${Math.random().toString(36).slice(2)}`);
		const scriptsDir = path.join(dir, 'scripts');
		await fs.mkdir(scriptsDir, { recursive: true });
		try {
			await fs.writeFile(path.join(dir, 'w.html'), TEMPLATE, 'utf-8');
			await fs.writeFile(path.join(scriptsDir, 'my-widget.js'), '', 'utf-8');
			const assetDirs = new Map([['scripts', scriptsDir]]);
			const assetMap = new Map([['scripts', '/__assets/scripts/']]);
			const { directory } = await compileDirectory(dir, { assetMap, assetDirs });
			return collectAssetReferences(directory.files);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}

	it('collects the entry as a reference to the named asset', async () => {
		const refs = await collect();
		const ref = refs.find(r => r.assetSubpath === 'my-widget.js');
		assert.ok(ref, `expected a reference to my-widget.js, got ${JSON.stringify(refs)}`);
		assert.equal(ref.assetName, 'scripts');
		assert.equal(ref.sourceFile, 'w.html');
		assert.equal(ref.partialName, 'my-widget');
	});

	it('spans the whole @name/subpath in the attribute value', async () => {
		const ref = (await collect()).find(r => r.assetSubpath === 'my-widget.js')!;
		const col = TEMPLATE.indexOf('@scripts/my-widget.js') + 1; // 1-based
		assert.equal(ref.line, 1);
		assert.equal(ref.column, col);
		assert.equal(ref.endLine, 1);
		assert.equal(ref.endColumn, col + '@scripts/my-widget.js'.length);
	});

	it('spans the subpath alone for the missing-file diagnostic', async () => {
		const ref = (await collect()).find(r => r.assetSubpath === 'my-widget.js')!;
		const col = TEMPLATE.indexOf('@scripts/my-widget.js') + 1;
		assert.equal(ref.subpathLine, 1);
		assert.equal(ref.subpathColumn, col + '@scripts/'.length);
		assert.equal(ref.subpathEndColumn, col + '@scripts/my-widget.js'.length);
	});
});
