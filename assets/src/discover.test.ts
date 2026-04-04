import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { discoverAssetFiles, discoverAssetFileInfos } from './discover.js';

const fixtureDir = path.resolve(import.meta.dirname!, '../../test/assets/images');

describe('discoverAssetFiles', () => {
	it('discovers all files in an asset directory', () => {
		const dirs = new Map([['images', fixtureDir]]);
		const refs = discoverAssetFiles(dirs);
		const subpaths = refs.map(r => r.subpath).sort();
		assert.deepEqual(subpaths, ['icon.png', 'photo.jpg', 'sub/nested.jpg']);
		for (const ref of refs) {
			assert.equal(ref.name, 'images');
			assert.ok(path.isAbsolute(ref.absolutePath));
		}
	});

	it('applies a filter', () => {
		const dirs = new Map([['images', fixtureDir]]);
		const refs = discoverAssetFiles(dirs, f => f.endsWith('.png'));
		assert.equal(refs.length, 1);
		assert.equal(refs[0].subpath, 'icon.png');
	});

	it('handles missing directories gracefully', () => {
		const dirs = new Map([['missing', '/nonexistent/path']]);
		const refs = discoverAssetFiles(dirs);
		assert.equal(refs.length, 0);
	});

	it('handles multiple asset directories', () => {
		const dirs = new Map([
			['images', fixtureDir],
			['images2', fixtureDir],
		]);
		const refs = discoverAssetFiles(dirs);
		assert.equal(refs.length, 6); // 3 files x 2 dirs
		assert.ok(refs.some(r => r.name === 'images'));
		assert.ok(refs.some(r => r.name === 'images2'));
	});
});

describe('discoverAssetFileInfos', () => {
	it('enriches refs with metadata', () => {
		const dirs = new Map([['images', fixtureDir]]);
		const infos = discoverAssetFileInfos(dirs);
		assert.equal(infos.length, 3);

		const photo = infos.find(i => i.subpath === 'photo.jpg')!;
		assert.equal(photo.ext, '.jpg');
		assert.equal(photo.isImage, true);
		assert.ok(photo.size > 0);

		const png = infos.find(i => i.subpath === 'icon.png')!;
		assert.equal(png.ext, '.png');
		assert.equal(png.isImage, true);
	});
});
