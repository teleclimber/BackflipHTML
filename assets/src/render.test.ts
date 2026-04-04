import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import type { AssetUsageReport } from './types.js';
import { renderAssetReportHtml } from './render.js';

function makeReport(overrides?: Partial<AssetUsageReport>): AssetUsageReport {
	return {
		generatedAt: '2026-01-01T00:00:00Z',
		entries: [
			{
				asset: { name: 'images', subpath: 'photo.jpg', absolutePath: '/a/photo.jpg', ext: '.jpg', size: 12345, isImage: true },
				references: [{ templateFile: 'index.html', partialName: 'hero', line: 5, column: 10, assetName: 'images', assetSubpath: 'photo.jpg' }],
				isUsed: true,
			},
			{
				asset: { name: 'images', subpath: 'orphan.png', absolutePath: '/a/orphan.png', ext: '.png', size: 500, isImage: true },
				references: [],
				isUsed: false,
			},
			{
				asset: { name: 'fonts', subpath: 'main.woff2', absolutePath: '/a/main.woff2', ext: '.woff2', size: 20480, isImage: false },
				references: [],
				isUsed: false,
			},
		],
		summary: { totalAssets: 3, usedAssets: 1, unusedAssets: 2, totalReferences: 1 },
		...overrides,
	};
}

describe('renderAssetReportHtml', () => {
	it('produces valid HTML with summary', () => {
		const html = renderAssetReportHtml(makeReport());
		assert.ok(html.includes('<!DOCTYPE html>'));
		assert.ok(html.includes('Asset Usage Report'));
		assert.ok(html.includes('<strong>3</strong> assets'));
		assert.ok(html.includes('<strong>1</strong> used'));
		assert.ok(html.includes('<strong>2</strong> unused'));
	});

	it('renders image thumbnails with assetBaseUrl', () => {
		const html = renderAssetReportHtml(makeReport(), { assetBaseUrl: '/__assets/' });
		assert.ok(html.includes('src="/__assets/images/photo.jpg"'));
	});

	it('renders placeholders for non-image assets', () => {
		const html = renderAssetReportHtml(makeReport());
		assert.ok(html.includes('.woff2'));
		assert.ok(html.includes('placeholder'));
	});

	it('renders used/unused badges', () => {
		const html = renderAssetReportHtml(makeReport());
		assert.ok(html.includes('badge used'));
		assert.ok(html.includes('badge unused'));
	});

	it('renders reference details as clickable links', () => {
		const html = renderAssetReportHtml(makeReport());
		assert.ok(html.includes('1 reference'));
		assert.ok(html.includes('ref-link'));
		assert.ok(html.includes('data-ref-file="index.html"'));
		assert.ok(html.includes('data-ref-line="5"'));
		assert.ok(html.includes('data-ref-col="10"'));
		assert.ok(html.includes('index.html'));
		assert.ok(html.includes('hero'));
	});

	it('renders asset links with data-asset-path', () => {
		const html = renderAssetReportHtml(makeReport());
		assert.ok(html.includes('asset-link'));
		assert.ok(html.includes('data-asset-path="/a/photo.jpg"'));
	});

	it('shows first 4 refs and hides the rest behind show-more', () => {
		const manyRefs = Array.from({ length: 6 }, (_, i) => ({
			templateFile: `file${i}.html`, partialName: `part${i}`, line: i + 1, column: 1, assetName: 'images', assetSubpath: 'photo.jpg',
		}));
		const report = makeReport({
			entries: [{
				asset: { name: 'images', subpath: 'photo.jpg', absolutePath: '/a/photo.jpg', ext: '.jpg', size: 100, isImage: true },
				references: manyRefs,
				isUsed: true,
			}],
			summary: { totalAssets: 1, usedAssets: 1, unusedAssets: 0, totalReferences: 6 },
		});
		const html = renderAssetReportHtml(report);
		// First 4 visible
		assert.ok(html.includes('data-ref-file="file0.html"'));
		assert.ok(html.includes('data-ref-file="file3.html"'));
		// Rest hidden
		assert.ok(html.includes('hidden-refs'));
		assert.ok(html.includes('show 2 more'));
	});

	it('includes live-reload script when requested', () => {
		const html = renderAssetReportHtml(makeReport(), { liveReload: true });
		assert.ok(html.includes('EventSource'));
		assert.ok(html.includes('__live-reload'));
	});

	it('omits live-reload script by default', () => {
		const html = renderAssetReportHtml(makeReport());
		assert.ok(!html.includes('EventSource'));
	});

	it('includes scope in heading when provided', () => {
		const html = renderAssetReportHtml(makeReport(), { scope: '@images/icons/' });
		assert.ok(html.includes('Asset Usage Report: <code>@images/icons/</code>'));
	});

	it('omits scope from heading when not provided', () => {
		const html = renderAssetReportHtml(makeReport());
		assert.ok(html.includes('<h1>Asset Usage Report</h1>'));
	});

	it('renders asset dir filter buttons when multiple dirs', () => {
		const html = renderAssetReportHtml(makeReport());
		assert.ok(html.includes('data-filter="fonts"'));
		assert.ok(html.includes('data-filter="images"'));
	});
});
