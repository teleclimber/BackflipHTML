import { assert, assertEquals, assertExists, assertStringIncludes } from "jsr:@std/assert";
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { RootTNode, CustomElementPartialRoot, ForTNode, IfTNode, ElementTNode, TNode, AttrPart } from "./types.ts";
import { resolveAssetRefs } from "./assets.ts";
import { compileFile, findElement, renderStatic } from "./test-helpers.ts";

// ---- asset test helpers ----

function collectAllAttrParts(tnodes: TNode[]): AttrPart[] {
	const out: AttrPart[] = [];
	function walk(ns: TNode[]) {
		for (const n of ns) {
			if (n.type === 'element') {
				const el = n as ElementTNode;
				for (const p of el.attrs) out.push(p);
				walk(el.tnodes);
			} else if (n.type === 'for') walk((n as ForTNode).tnodes);
			else if (n.type === 'if') for (const b of (n as IfTNode).branches) walk(b.tnodes);
			else if (n.type === 'partial-ref') {
				if (n.kind === 'custom-element') {
					if (n.callerAttrs) for (const p of n.callerAttrs) out.push(p);
				}
				for (const sl of Object.values(n.slots)) walk(sl);
			}
		}
	}
	walk(tnodes);
	return out;
}

// Render the static-only portion of a root (with all ElementTNode open/close tags) into a string.
function rootRenderStatic(root: RootTNode): string {
	return renderStatic(root.tnodes);
}

const ASSET_TMPDIR = '/tmp/claude-1000/';

async function makeAssetFixture(): Promise<{ assetMap: Map<string, string>, assetDirs: Map<string, string>, dir: string }> {
	const dir = path.join(ASSET_TMPDIR, `asset_test_${Date.now()}`);
	const imgDir = path.join(dir, 'images');
	await fs.mkdir(imgDir, { recursive: true });
	await fs.writeFile(path.join(imgDir, 'photo.jpg'), 'fake-image');
	await fs.writeFile(path.join(imgDir, 'icon.png'), 'fake-icon');
	await fs.mkdir(path.join(imgDir, 'sub'), { recursive: true });
	await fs.writeFile(path.join(imgDir, 'sub', 'nested.jpg'), 'fake-nested');
	const assetMap = new Map([['images', '/img/']]);
	const assetDirs = new Map([['images', imgDir]]);
	return { assetMap, assetDirs, dir };
}

// ---- asset attribute tests ----

Deno.test("asset: static src~ produces 'asset' AttrPart in stage 1", async () => {
	const { assetMap, assetDirs } = await makeAssetFixture();
	const { compiled } = await compileFile(
		'<div b-name="hero"><img src~="@images/photo.jpg" /></div>',
		undefined, 'test.html', { assetMap, assetDirs }
	);
	const root = compiled.partials.get("hero")!;
	const assetParts = collectAllAttrParts(root.tnodes).filter(p => p.type === 'asset') as Extract<AttrPart, { type: 'asset' }>[];
	assertEquals(assetParts.length, 1);
	assertEquals(assetParts[0].attrName, 'src');
	assertEquals(assetParts[0].originalValue, '@images/photo.jpg');
	assertEquals(assetParts[0].refs.length, 1);
	assertEquals(assetParts[0].refs[0].name, 'images');
	assertEquals(assetParts[0].refs[0].subpath, 'photo.jpg');

	// Stage 2: resolveAssetRefs produces resolved static parts in the same element
	const resolved = resolveAssetRefs(compiled, assetMap);
	const resolvedRoot = resolved.partials.get("hero")!;
	const out = rootRenderStatic(resolvedRoot);
	assertStringIncludes(out, 'src="/img/photo.jpg"');
	assertEquals(out.includes('~'), false);
	assertEquals(out.includes('@images'), false);
});

Deno.test("asset: static src~ with subpath", async () => {
	const { assetMap, assetDirs } = await makeAssetFixture();
	const { compiled } = await compileFile(
		'<div b-name="hero"><img src~="@images/sub/nested.jpg" /></div>',
		undefined, 'test.html', { assetMap, assetDirs }
	);
	const root = compiled.partials.get("hero")!;
	const assetParts = collectAllAttrParts(root.tnodes).filter(p => p.type === 'asset') as Extract<AttrPart, { type: 'asset' }>[];
	assertEquals(assetParts.length, 1);
	assertEquals(assetParts[0].refs[0].subpath, 'sub/nested.jpg');

	const resolved = resolveAssetRefs(compiled, assetMap);
	assertStringIncludes(rootRenderStatic(resolved.partials.get("hero")!), 'src="/img/sub/nested.jpg"');
});

Deno.test("asset: resolved src~ keeps the quote style it was written with", async () => {
	const { assetMap, assetDirs } = await makeAssetFixture();
	const { compiled } = await compileFile(
		`<div b-name="hero"><img src~='@images/photo.jpg' /></div>`,
		undefined, 'test.html', { assetMap, assetDirs }
	);
	const resolved = resolveAssetRefs(compiled, assetMap);
	assertStringIncludes(rootRenderStatic(resolved.partials.get("hero")!), `src='/img/photo.jpg'`);
});

Deno.test("asset: an unquoted src~ resolves to a double-quoted attr", async () => {
	const { assetMap, assetDirs } = await makeAssetFixture();
	const { compiled } = await compileFile(
		'<div b-name="hero"><img src~=@images/photo.jpg></div>',
		undefined, 'test.html', { assetMap, assetDirs }
	);
	const resolved = resolveAssetRefs(compiled, assetMap);
	assertStringIncludes(rootRenderStatic(resolved.partials.get("hero")!), 'src="/img/photo.jpg"');
});

Deno.test("asset: error when @name not in asset map", async () => {
	const assetMap = new Map([['images', '/img/']]);
	const { errors } = await compileFile(
		'<div b-name="hero"><img src~="@unknown/photo.jpg" /></div>',
		undefined, 'test.html', { assetMap }
	);
	assertEquals(errors.length, 1);
	assertStringIncludes(errors[0].message, 'unknown asset directory "@unknown"');
});

Deno.test("asset: error when value doesn't start with @", async () => {
	const assetMap = new Map([['images', '/img/']]);
	const { errors } = await compileFile(
		'<div b-name="hero"><img src~="photo.jpg" /></div>',
		undefined, 'test.html', { assetMap }
	);
	assertEquals(errors.length, 1);
	assertStringIncludes(errors[0].message, 'must start with @name');
});

Deno.test("asset: error on path traversal in subpath", async () => {
	const { assetMap, assetDirs } = await makeAssetFixture();
	const { errors } = await compileFile(
		'<div b-name="hero"><img src~="@images/../../../etc/passwd" /></div>',
		undefined, 'test.html', { assetMap, assetDirs }
	);
	assertEquals(errors.length, 1);
	assertStringIncludes(errors[0].message, 'path traversal');
});

Deno.test("asset: style~ is an error", async () => {
	const assetMap = new Map([['images', '/img/']]);
	const { errors } = await compileFile(
		'<div b-name="hero"><div style~="@images/bg.jpg"></div></div>',
		undefined, 'test.html', { assetMap }
	);
	assertEquals(errors.length, 1);
	assertStringIncludes(errors[0].message, 'style~ is not supported');
});

Deno.test("asset: :src~ (bind) produces isAsset dynamic AttrPart", async () => {
	const assetMap = new Map([['images', '/img/']]);
	const { compiled } = await compileFile(
		`<div b-name="hero"><img :src~="'@images/' + file + '.jpg'" /></div>`,
		undefined, 'test.html', { assetMap }
	);
	const root = compiled.partials.get("hero")!;
	const img = findElement(root.tnodes, 'img')!;
	const dynamicPart = img.attrs.find(p => p.type === 'dynamic') as Extract<AttrPart, { type: 'dynamic' }> | undefined;
	assertExists(dynamicPart);
	assertEquals(dynamicPart!.name, 'src');
	assertEquals(dynamicPart!.isAsset, true);
});

Deno.test("asset: :style~ (bind) is an error", async () => {
	const assetMap = new Map([['images', '/img/']]);
	const { errors } = await compileFile(
		`<div b-name="hero"><div :style~="'@images/bg.jpg'"></div></div>`,
		undefined, 'test.html', { assetMap }
	);
	assertEquals(errors.length, 1);
	assertStringIncludes(errors[0].message, 'style~ is not supported');
});

Deno.test("asset: srcset~ validates multiple entries", async () => {
	const { assetMap, assetDirs } = await makeAssetFixture();
	const { compiled, errors } = await compileFile(
		'<div b-name="hero"><img srcset~="@images/photo.jpg 1x, @images/icon.png 2x" /></div>',
		undefined, 'test.html', { assetMap, assetDirs }
	);
	assertEquals(errors.length, 0);
	const root = compiled.partials.get("hero")!;
	const assetParts = collectAllAttrParts(root.tnodes).filter(p => p.type === 'asset') as Extract<AttrPart, { type: 'asset' }>[];
	assertEquals(assetParts.length, 1);
	assertEquals(assetParts[0].attrName, 'srcset');
	assertEquals(assetParts[0].refs.length, 2);
	assertEquals(assetParts[0].refs[0].name, 'images');
	assertEquals(assetParts[0].refs[0].subpath, 'photo.jpg');
	assertEquals(assetParts[0].refs[1].subpath, 'icon.png');

	const resolved = resolveAssetRefs(compiled, assetMap);
	assertStringIncludes(rootRenderStatic(resolved.partials.get("hero")!), 'srcset="/img/photo.jpg 1x, /img/icon.png 2x"');
});

Deno.test("asset: no asset map produces error for ~ attribute", async () => {
	const { errors } = await compileFile(
		'<div b-name="hero"><img src~="@images/photo.jpg" /></div>',
		undefined, 'test.html', {}
	);
	assertEquals(errors.length, 1);
	assertStringIncludes(errors[0].message, 'no asset directories');
});

Deno.test("asset: error when using :bind~ attribute with no assets configured", async () => {
	const { errors } = await compileFile(
		`<div b-name="hero"><img :src~="'@images/' + f" /></div>`,
		undefined, 'test.html'
	);
	assertEquals(errors.length, 1);
	assertStringIncludes(errors[0].message, 'no asset directories');
});

Deno.test("asset: error location spans the full attribute", async () => {
	const assetMap = new Map([['images', '/img/']]);
	const { errors } = await compileFile(
		'<div b-name="hero"><img src~="@unknown/photo.jpg" /></div>',
		undefined, 'test.html', { assetMap }
	);
	assertEquals(errors.length, 1);
	// The error should have endLine/endCol spanning the full src~="..." attribute
	assertExists(errors[0].endLine);
	assertExists(errors[0].endCol);
	assert(errors[0].endCol! > errors[0].col! + 1, `endCol (${errors[0].endCol}) should be greater than col+1 (${errors[0].col! + 1})`);
});

Deno.test("asset: mixed static asset + bind produces asset AttrPart", async () => {
	const assetMap = new Map([['images', '/img/']]);
	const { compiled } = await compileFile(
		`<div b-name="hero"><img src~="@images/photo.jpg" :alt="desc" /></div>`,
		undefined, 'test.html', { assetMap }
	);
	const root = compiled.partials.get("hero")!;
	const img = findElement(root.tnodes, 'img')!;
	const assetPart = img.attrs.find(p => p.type === 'asset') as Extract<AttrPart, { type: 'asset' }> | undefined;
	assertExists(assetPart);
	assertEquals(assetPart!.attrName, 'src');
	assertEquals(assetPart!.originalValue, '@images/photo.jpg');
	assertEquals(assetPart!.refs[0].name, 'images');

	// Stage 2: asset AttrPart resolved to static within the same element.
	const resolved = resolveAssetRefs(compiled, assetMap);
	const resolvedImg = findElement(resolved.partials.get("hero")!.tnodes, 'img')!;
	assertEquals(resolvedImg.attrs.some(p => p.type === 'asset'), false);
	const staticRaw = resolvedImg.attrs.filter(p => p.type === 'static').map(p => (p as { raw: string }).raw).join('');
	assertStringIncludes(staticRaw, 'src="/img/photo.jpg"');
});

Deno.test("asset: resolveAssetRefs does not mutate original", async () => {
	const { assetMap, assetDirs } = await makeAssetFixture();
	const { compiled } = await compileFile(
		'<div b-name="hero"><img src~="@images/photo.jpg" /></div>',
		undefined, 'test.html', { assetMap, assetDirs }
	);
	const root = compiled.partials.get("hero")!;
	const beforeCount = collectAllAttrParts(root.tnodes).filter(p => p.type === 'asset').length;
	assertEquals(beforeCount, 1);

	resolveAssetRefs(compiled, assetMap);

	// Original should still have its 'asset' AttrPart unresolved.
	const afterCount = collectAllAttrParts(root.tnodes).filter(p => p.type === 'asset').length;
	assertEquals(afterCount, 1);
});

Deno.test("asset: resolveAssetRefs preserves and rewrites a custom-element root's scripts", async () => {
	const assetMap = new Map([['images', '/img/'], ['script', '/js/']]);
	// A reactive custom element that also carries an asset ref, so resolveAssetRefs
	// has work to do and rebuilds the root. b-script gives it an unresolved entry.
	const { compiled } = await compileFile(
		`<my-badge b-attr:level b-script="@script/badge.js" :class="level > 80 ? 'high' : ''" b-export><img src~="@images/icon.png" /></my-badge>`,
		undefined, 'test.html', { assetMap }
	);
	const root = compiled.partials.get("my-badge")! as CustomElementPartialRoot;
	assertEquals(root.kind, 'custom-element');
	// The entry from b-script is stored unresolved (an @-path) until resolveAssetRefs runs.
	assertEquals(root.scripts, [{ url: '@script/badge.js', kind: 'entry' }]);
	// Append a dependency the way applyDomPatch does (already an absolute URL).
	root.scripts!.push({ url: '/static-bfdom/test.js', kind: 'dependency' });

	const resolved = resolveAssetRefs(compiled, assetMap);
	const resolvedRoot = resolved.partials.get("my-badge")! as CustomElementPartialRoot;
	// The entry's @-prefix is rewritten; the absolute dependency URL is untouched.
	assertEquals(resolvedRoot.scripts, [
		{ url: '/js/badge.js', kind: 'entry' },
		{ url: '/static-bfdom/test.js', kind: 'dependency' },
	]);
});
