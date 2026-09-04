import { describe, it, before, after } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildPayload, findConfigDir, resolveInput } from './project.js';

/**
 * Resolving a project's asset configuration.
 *
 * Without an asset map the compiler drops every `src~` attribute and reports
 * each one, so a run that misses the configuration is not merely noisy — it
 * analyses elements that have lost the attributes selectors look at. These
 * tests hold both halves of that: the diagnostics stay away, and the attribute
 * is still there to match against.
 */

let root: string;

/** A project with one asset dir, one template using it, and a stylesheet. */
before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'explain-assets-'));
	fs.mkdirSync(path.join(root, 'templates'), { recursive: true });
	fs.mkdirSync(path.join(root, 'static', 'img'), { recursive: true });
	fs.writeFileSync(path.join(root, 'backflip.json'), JSON.stringify({
		root: 'templates',
		assets: [{ name: 'images', path: 'static/img', prefix: '/assets/img/' }],
	}));
	fs.writeFileSync(path.join(root, 'templates', 'page.html'),
		'<div b-name="page" class="hero"><img src~="@images/logo.png" alt="logo"></div>\n');
	fs.writeFileSync(path.join(root, 'static', 'img', 'site.css'),
		'.hero { color: red }\n.hero img[src^="@images/"] { border: 0 }\n');
});

after(() => { fs.rmSync(root, { recursive: true, force: true }); });

/** The same project with `assets` removed from its config. */
function withoutAssets(): string {
	const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'explain-noassets-'));
	fs.cpSync(root, bare, { recursive: true });
	fs.writeFileSync(path.join(bare, 'backflip.json'), JSON.stringify({ root: 'templates' }));
	return bare;
}

describe('asset configuration', () => {
	it('reads the asset dirs out of the project config', async () => {
		const resolved = await resolveInput({ demo: false, project: root, css: [] });
		deepStrictEqual([...resolved.compileOptions!.assetMap!.entries()], [['images', '/assets/img/']]);
		deepStrictEqual(
			[...resolved.compileOptions!.assetDirs!.entries()],
			[['images', path.join(root, 'static', 'img')]],
		);
		strictEqual(resolved.configDir, root);
	});

	it('compiles asset attributes instead of complaining about them', async () => {
		const payload = await buildPayload({ demo: false, project: root, css: [] });
		deepStrictEqual(payload.meta.warnings, []);
		deepStrictEqual(payload.meta.assetDirs, ['images']);
	});

	it('keeps the attribute, so selectors reading it still match', async () => {
		const payload = await buildPayload({ demo: false, project: root, css: [] });
		const selector = payload.selectors.find(s => s.text.includes('img[src'));
		ok(selector, 'the stylesheet has a selector on the asset attribute');
		strictEqual(selector.hits.length, 1);
	});

	it('is the thing that keeps the diagnostic away', async () => {
		// The failure the fix is for: same templates, no asset dirs configured.
		const bare = withoutAssets();
		try {
			// The stylesheet has to be named: with no asset dirs there is nowhere
			// for `--project` to discover one.
			const payload = await buildPayload({
				demo: false, project: bare, css: [path.join(bare, 'static', 'img', 'site.css')],
			});
			deepStrictEqual(payload.meta.assetDirs, []);
			ok(payload.meta.warnings.some(w => w.includes('no asset directories are configured')));
			ok(!payload.selectors.find(s => s.text.includes('img[src'))!.hits.length,
				'the dropped attribute takes the match with it');
		} finally {
			fs.rmSync(bare, { recursive: true, force: true });
		}
	});

	it('finds the config above a hand-pointed template dir', async () => {
		strictEqual(findConfigDir(path.join(root, 'templates')), root);
		const resolved = await resolveInput({
			demo: false,
			templates: path.join(root, 'templates'),
			css: [path.join(root, 'static', 'img', 'site.css')],
		});
		deepStrictEqual([...resolved.compileOptions!.assetMap!.keys()], ['images']);
	});

	it('reports no config rather than inventing one', async () => {
		const orphan = fs.mkdtempSync(path.join(os.tmpdir(), 'explain-orphan-'));
		try {
			fs.writeFileSync(path.join(orphan, 'page.html'), '<div b-name="page" class="a"></div>');
			fs.writeFileSync(path.join(orphan, 'a.css'), '.a { color: red }');
			// mkdtemp roots sit under the OS temp dir, which has no backflip.json above it.
			strictEqual(findConfigDir(orphan), null);
			const payload = await buildPayload({
				demo: false, templates: orphan, css: [path.join(orphan, 'a.css')],
			});
			deepStrictEqual(payload.meta.assetDirs, []);
			strictEqual(payload.meta.configDir, undefined);
		} finally {
			fs.rmSync(orphan, { recursive: true, force: true });
		}
	});
});
