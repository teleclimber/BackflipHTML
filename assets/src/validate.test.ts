import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { validateAssetFiles } from './validate.js';
import type { AssetReference } from './types.js';

describe('validateAssetFiles', () => {
	it('returns no errors when all files exist', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backflip-test-'));
		const imgPath = path.join(tmpDir, 'photo.jpg');
		fs.writeFileSync(imgPath, 'fake-image');

		const assetDirs = new Map([['images', tmpDir]]);
		const refs: AssetReference[] = [
			{
				sourceFile: 'test.html',
				partialName: 'hero',
				line: 1,
				column: 5,
				assetName: 'images',
				assetSubpath: 'photo.jpg'
			}
		];

		const errors = validateAssetFiles(refs, assetDirs);
		assert.equal(errors.length, 0);

		fs.rmSync(tmpDir, { recursive: true });
	});

	it('returns errors for missing files', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backflip-test-'));
		const assetDirs = new Map([['images', tmpDir]]);
		const refs: AssetReference[] = [
			{
				sourceFile: 'test.html',
				partialName: 'hero',
				line: 1,
				column: 5,
				assetName: 'images',
				assetSubpath: 'missing.jpg'
			}
		];

		const errors = validateAssetFiles(refs, assetDirs);
		assert.equal(errors.length, 1);
		assert.ok(errors[0].message.includes('asset file not found'));
		assert.ok(errors[0].message.includes('@images/missing.jpg'));
		assert.equal(errors[0].filename, 'test.html');
		assert.equal(errors[0].line, 1);
		assert.equal(errors[0].col, 5);

		fs.rmSync(tmpDir, { recursive: true });
	});

	it('works with multiple references and directories', () => {
		const tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'backflip-test-1-'));
		const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'backflip-test-2-'));
		
		fs.writeFileSync(path.join(tmpDir1, 'exists.jpg'), 'data');
		
		const assetDirs = new Map([
			['dir1', tmpDir1],
			['dir2', tmpDir2]
		]);

		const refs: AssetReference[] = [
			{
				sourceFile: 'a.html',
				line: 1,
				column: 1,
				assetName: 'dir1',
				assetSubpath: 'exists.jpg'
			},
			{
				sourceFile: 'b.html',
				line: 2,
				column: 2,
				assetName: 'dir2',
				assetSubpath: 'missing.jpg'
			}
		];

		const errors = validateAssetFiles(refs, assetDirs);
		assert.equal(errors.length, 1);
		assert.ok(errors[0].message.includes('@dir2/missing.jpg'));
		assert.equal(errors[0].filename, 'b.html');

		fs.rmSync(tmpDir1, { recursive: true });
		fs.rmSync(tmpDir2, { recursive: true });
	});

	it('handles multiple references at the same location (e.g. srcset)', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backflip-srcset-test-'));
		fs.writeFileSync(path.join(tmpDir, 'exists.jpg'), 'data');
		
		const assetDirs = new Map([['images', tmpDir]]);
		const refs: AssetReference[] = [
			{
				sourceFile: 'srcset.html',
				line: 10,
				column: 5,
				assetName: 'images',
				assetSubpath: 'exists.jpg'
			},
			{
				sourceFile: 'srcset.html',
				line: 10,
				column: 5,
				assetName: 'images',
				assetSubpath: 'missing.jpg'
			}
		];

		const errors = validateAssetFiles(refs, assetDirs);
		assert.equal(errors.length, 1);
		assert.ok(errors[0].message.includes('@images/missing.jpg'));
		assert.equal(errors[0].line, 10);

		fs.rmSync(tmpDir, { recursive: true });
	});
});
