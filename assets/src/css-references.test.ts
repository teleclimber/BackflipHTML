import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { collectCssAssetReferences } from './css-references.js';

describe('collectCssAssetReferences', () => {
	it('collects URLs from CSS files and resolves them', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backflip-test-'));
		const imgDir = path.join(tmpDir, 'img');
		const cssDir = path.join(tmpDir, 'css');
		fs.mkdirSync(imgDir);
		fs.mkdirSync(cssDir);

		// Create some "assets"
		fs.writeFileSync(path.join(imgDir, 'logo.png'), 'png');
		fs.writeFileSync(path.join(imgDir, 'bg.jpg'), 'jpg');

		// Create a CSS file that references them
		const cssFile = path.join(cssDir, 'style.css');
		fs.writeFileSync(cssFile, `
			body { background: url("../img/bg.jpg"); }
			.logo { content: url('../img/logo.png'); }
			.external { background: url("https://example.com/ext.png"); }
			.data { background: url("data:image/png;base64,..."); }
			.outside { background: url("../../outside.png"); }
		`);

		const assetDirs = new Map([
			['images', imgDir],
			['styles', cssDir],
		]);

		const refs = collectCssAssetReferences(assetDirs);

		// Should find bg.jpg and logo.png from styles/style.css
		// Resolved against styles/ (CSS dir), so ../img/bg.jpg -> img/bg.jpg
		// But wait, the assetName for these refs should be 'images' because they resolve into 'img' dir?
		// NO! My implementation currently uses the name of the directory where the CSS file WAS found.
		// "assetName: cssRef.name"
		// If a CSS file in 'styles' references something that resolves into 'images' dir,
		// it should ideally be attributed to 'images'.

		// Let's check my implementation again:
		// const baseDir = assetDirs.get(cssRef.name)!;
		// const relativeToBase = path.relative(baseDir, absolutePath);
		// const isInside = !relativeToBase.startsWith('..') && !path.isAbsolute(relativeToBase);
		// if (isInside) { ... assetName: cssRef.name ... }

		// This means it only finds assets within the SAME asset directory as the CSS file.
		// Let's re-read the user's prompt:
		// "for each asset dir, iterate over the css files, and find the assets that are used in them (via url())"
		// "If the path traverses outside the curent asset directory (as defined in backflip.json), then ignore it."

		// So my implementation matches the requirement: it only looks for assets within the same asset directory.

		const styleRefs = refs.filter(r => r.sourceFile === 'style.css');
		// In this test, ../img/bg.jpg is OUTSIDE the 'styles' directory.
		// So it should be ignored according to the requirement.

		// Let's create a CSS file inside 'img' to test.
		fs.writeFileSync(path.join(imgDir, 'inner.css'), `
			.test { background: url("logo.png"); }
			.sub { background: url("icons/icon.png"); }
		`);
		fs.mkdirSync(path.join(imgDir, 'icons'));
		fs.writeFileSync(path.join(imgDir, 'icons/icon.png'), 'png');

		const imgRefs = collectCssAssetReferences(assetDirs).filter(r => r.sourceFile === 'inner.css');

		assert.equal(imgRefs.length, 2);
		assert.ok(imgRefs.some(r => r.assetSubpath === 'logo.png' && r.assetName === 'images'));
		assert.ok(imgRefs.some(r => r.assetSubpath === 'icons/icon.png' && r.assetName === 'images'));

		// Cleanup
		fs.rmSync(tmpDir, { recursive: true });
	});
});
