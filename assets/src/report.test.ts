import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import type { AssetFileInfo, AssetReference } from './types.js';
import { buildAssetUsageReport, filterReport } from './report.js';

function makeAsset(name: string, subpath: string): AssetFileInfo {
	return { name, subpath, absolutePath: `/assets/${name}/${subpath}`, ext: '.jpg', size: 100, isImage: true };
}

function makeRef(assetName: string, assetSubpath: string, partial = 'main'): AssetReference {
	return { templateFile: 'index.html', partialName: partial, line: 1, column: 1, assetName, assetSubpath };
}

describe('buildAssetUsageReport', () => {
	it('marks used and unused assets', () => {
		const assets = [makeAsset('images', 'photo.jpg'), makeAsset('images', 'orphan.jpg')];
		const refs = [makeRef('images', 'photo.jpg')];
		const report = buildAssetUsageReport(assets, refs);

		assert.equal(report.entries.length, 2);
		assert.equal(report.summary.totalAssets, 2);
		assert.equal(report.summary.usedAssets, 1);
		assert.equal(report.summary.unusedAssets, 1);
		assert.equal(report.summary.totalReferences, 1);

		const used = report.entries.find(e => e.asset.subpath === 'photo.jpg')!;
		assert.equal(used.isUsed, true);
		assert.equal(used.references.length, 1);

		const unused = report.entries.find(e => e.asset.subpath === 'orphan.jpg')!;
		assert.equal(unused.isUsed, false);
		assert.equal(unused.references.length, 0);
	});

	it('groups multiple references to the same asset', () => {
		const assets = [makeAsset('images', 'photo.jpg')];
		const refs = [makeRef('images', 'photo.jpg', 'header'), makeRef('images', 'photo.jpg', 'footer')];
		const report = buildAssetUsageReport(assets, refs);

		assert.equal(report.entries[0].references.length, 2);
		assert.equal(report.summary.totalReferences, 2);
	});

	it('handles empty inputs', () => {
		const report = buildAssetUsageReport([], []);
		assert.equal(report.entries.length, 0);
		assert.equal(report.summary.totalAssets, 0);
	});

	it('filters out unused common OS files', () => {
		const assets = [
			makeAsset('images', 'photo.jpg'),
			makeAsset('images', '.DS_Store'),
			makeAsset('images', 'Thumbs.db'),
			makeAsset('images', 'nested/.DS_Store')
		];
		const refs = [makeRef('images', 'photo.jpg')];
		const report = buildAssetUsageReport(assets, refs);

		assert.equal(report.entries.length, 1);
		assert.equal(report.summary.totalAssets, 1);
		assert.equal(report.summary.unusedAssets, 0);
	});

	it('includes common OS files if they are explicitly referenced', () => {
		const assets = [
			makeAsset('images', 'photo.jpg'),
			makeAsset('images', '.DS_Store')
		];
		const refs = [makeRef('images', '.DS_Store')];
		const report = buildAssetUsageReport(assets, refs);

		assert.equal(report.entries.length, 2);
		assert.equal(report.summary.totalAssets, 2);
		assert.equal(report.summary.usedAssets, 1);
		assert.equal(report.summary.unusedAssets, 1);
	});
});

describe('filterReport', () => {
	it('filters by asset dir name', () => {
		const assets = [makeAsset('images', 'a.jpg'), makeAsset('icons', 'b.svg')];
		const refs = [makeRef('images', 'a.jpg')];
		const report = buildAssetUsageReport(assets, refs);
		const filtered = filterReport(report, { name: 'icons' });

		assert.equal(filtered.entries.length, 1);
		assert.equal(filtered.entries[0].asset.name, 'icons');
		assert.equal(filtered.summary.unusedAssets, 1);
	});

	it('filters by exact subpath', () => {
		const assets = [makeAsset('images', 'icons/a.svg'), makeAsset('images', 'icons/b.svg'), makeAsset('images', 'photo.jpg')];
		const report = buildAssetUsageReport(assets, []);
		const filtered = filterReport(report, { name: 'images', subpath: 'photo.jpg' });

		assert.equal(filtered.entries.length, 1);
		assert.equal(filtered.entries[0].asset.subpath, 'photo.jpg');
	});

	it('filters by subpath prefix', () => {
		const assets = [makeAsset('images', 'icons/a.svg'), makeAsset('images', 'icons/b.svg'), makeAsset('images', 'photo.jpg')];
		const report = buildAssetUsageReport(assets, []);
		const filtered = filterReport(report, { name: 'images', subpathPrefix: 'icons/' });

		assert.equal(filtered.entries.length, 2);
		assert.ok(filtered.entries.every(e => e.asset.subpath.startsWith('icons/')));
	});

	it('filters unused only', () => {
		const assets = [makeAsset('images', 'a.jpg'), makeAsset('images', 'b.jpg')];
		const refs = [makeRef('images', 'a.jpg')];
		const report = buildAssetUsageReport(assets, refs);
		const filtered = filterReport(report, { unusedOnly: true });

		assert.equal(filtered.entries.length, 1);
		assert.equal(filtered.entries[0].asset.subpath, 'b.jpg');
	});
});
