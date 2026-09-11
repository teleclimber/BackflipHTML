import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { compileFiles } from '@backflip/html';
import type { CompiledFile } from '@backflip/html';
import { resolveAt, elementAt, targetAt } from './resolve.js';

/** Compile one template and hand back the file plus an offset-finder for it. */
async function fixture(src: string): Promise<{
	file: CompiledFile;
	/** Offset of the cursor inside `needle`, `at` characters in (default: middle). */
	at: (needle: string, offsetInNeedle?: number) => number;
}> {
	const { directory } = await compileFiles(new Map([['page.html', src]]));
	const file = directory.files.get('page.html')!;
	return {
		file,
		at(needle: string, offsetInNeedle?: number) {
			const i = src.indexOf(needle);
			if (i === -1) throw new Error(`fixture has no ${JSON.stringify(needle)}`);
			return i + (offsetInNeedle ?? Math.floor(needle.length / 2));
		},
	};
}

describe('resolveAt — elements', () => {
	// The bug this exists for: two elements on one line resolved to whichever
	// came first, because the answer was found by regexing the line text.
	const SIBLINGS = '<div b-name="page"><span>Email: </span><a href="mailto:x@y.z">email</a></div>';

	it('distinguishes two elements on the same line', async () => {
		const { file, at } = await fixture(SIBLINGS);
		strictEqual(elementAt(file, at('<span'))!.tagName, 'span');
		strictEqual(elementAt(file, at('<a href'))!.tagName, 'a');
		strictEqual(elementAt(file, at('mailto:x@y.z'))!.tagName, 'a');
		strictEqual(elementAt(file, at('>email<'))!.tagName, 'a');
		strictEqual(elementAt(file, at('</a>'))!.tagName, 'a');
	});

	it('resolves text content to the element containing it', async () => {
		const { file, at } = await fixture(SIBLINGS);
		strictEqual(elementAt(file, at('Email: '))!.tagName, 'span');
	});

	it('resolves the innermost element, not an ancestor', async () => {
		const { file, at } = await fixture('<div b-name="page"><section><p><b>hi</b></p></section></div>');
		strictEqual(elementAt(file, at('<b>'))!.tagName, 'b');
		strictEqual(elementAt(file, at('<p>'))!.tagName, 'p');
		strictEqual(elementAt(file, at('<section'))!.tagName, 'section');
	});

	it('lists ancestors after the innermost element', async () => {
		const { file, at } = await fixture('<div b-name="page"><section><p><b>hi</b></p></section></div>');
		const tags = resolveAt(file, at('hi'))
			.filter(t => t.kind === 'element')
			.map(t => (t as { node: { tagName: string } }).node.tagName);
		deepStrictEqual(tags, ['b', 'p', 'section', 'div']);
	});

	it('resolves an element whose open tag spans several lines', async () => {
		const { file, at } = await fixture([
			'<div b-name="page">',
			'  <a',
			'    href="mailto:x@y.z"',
			'    class="mail">email</a>',
			'</div>',
		].join('\n'));
		strictEqual(elementAt(file, at('class="mail"'))!.tagName, 'a');
		strictEqual(elementAt(file, at('href="mailto'))!.tagName, 'a');
	});

	it('gives touching siblings a clean boundary', async () => {
		const { file } = await fixture(SIBLINGS);
		// `</span>` ends at exactly the offset `<a` starts at. That offset is the
		// `<` of the anchor and must resolve to the anchor alone.
		const boundary = SIBLINGS.indexOf('<a href');
		strictEqual(elementAt(file, boundary)!.tagName, 'a');
		strictEqual(elementAt(file, boundary - 1)!.tagName, 'span');
	});

	it('resolves nothing outside any partial definition', async () => {
		// Content outside a definition never reaches a compiled tree.
		const { file, at } = await fixture('<div class="loose">text</div>');
		deepStrictEqual(resolveAt(file, at('loose')), []);
	});
});

describe('resolveAt — directives', () => {
	const SRC = [
		'<div b-name="page">',
		'  <div b-part="#card" b-data:title="t">',
		'    <p b-in="foot">x</p>',
		'  </div>',
		'  <span>{{ v }}</span>',
		'</div>',
		'<div b-name="card">',
		'  <h2 b-slot>t</h2>',
		'  <div b-slot="foot">f</div>',
		'</div>',
		'<my-widget b-attr:label>',
		'  <b>{{ label }}</b>',
		'</my-widget>',
	].join('\n');

	it('resolves b-part to the call, not the element carrying it', async () => {
		const { file, at } = await fixture(SRC);
		const t = targetAt(file, at('b-part="#card"'), 'b-part');
		ok(t, 'expected a b-part target');
		strictEqual(t!.node.partialName, 'card');
		// It is narrower than the element, so it sorts ahead of it.
		strictEqual(resolveAt(file, at('b-part="#card"'))[0].kind, 'b-part');
	});

	it('resolves b-name', async () => {
		const { file, at } = await fixture(SRC);
		strictEqual(targetAt(file, at('b-name="page"'), 'b-name')!.partialName, 'page');
		strictEqual(targetAt(file, at('b-name="card"'), 'b-name')!.partialName, 'card');
	});

	it('resolves b-in and names the call it fills, with no upward scan', async () => {
		const { file, at } = await fixture(SRC);
		const t = targetAt(file, at('b-in="foot"'), 'b-in');
		ok(t, 'expected a b-in target');
		strictEqual(t!.slotName, 'foot');
		strictEqual(t!.node.partialName, 'card');
	});

	it('resolves b-slot, bare and with a name', async () => {
		const { file, at } = await fixture(SRC);
		strictEqual(targetAt(file, at('b-slot>'), 'b-slot')!.slotName, undefined);
		strictEqual(targetAt(file, at('b-slot="foot"'), 'b-slot')!.slotName, 'foot');
	});

	it('resolves b-data to its binding name', async () => {
		const { file, at } = await fixture(SRC);
		const t = targetAt(file, at('b-data:title', 9), 'b-data');
		ok(t, 'expected a b-data target');
		strictEqual(t!.bindingName, 'title');
	});

	it('resolves b-attr on a custom element definition', async () => {
		const { file, at } = await fixture(SRC);
		strictEqual(targetAt(file, at('b-attr:label'), 'b-attr')!.attrName, 'label');
	});

	it('resolves the custom element definition tag', async () => {
		const { file, at } = await fixture(SRC);
		strictEqual(targetAt(file, at('<my-widget b-attr'), 'custom-element-def')!.partialName, 'my-widget');
	});

	it('resolves an interpolation', async () => {
		const { file, at } = await fixture(SRC);
		ok(targetAt(file, at('{{ v }}'), 'print'), 'expected a print target');
	});

	it('names the partial each target belongs to', async () => {
		const { file, at } = await fixture(SRC);
		strictEqual(targetAt(file, at('b-in="foot"'), 'b-in')!.partialName, 'page');
		strictEqual(targetAt(file, at('b-slot="foot"'), 'b-slot')!.partialName, 'card');
	});
});

describe('resolveAt — two of the same directive on one line', () => {
	// Each of these was invisible to a non-global regex that took the first hit.
	it('tells two b-part calls on one line apart', async () => {
		const { file, at } = await fixture(
			'<div b-name="page"><i b-part="#a"></i><i b-part="#b"></i></div>',
		);
		strictEqual(targetAt(file, at('b-part="#a"'), 'b-part')!.node.partialName, 'a');
		strictEqual(targetAt(file, at('b-part="#b"'), 'b-part')!.node.partialName, 'b');
	});

	it('tells two b-slot attributes on one line apart', async () => {
		const { file, at } = await fixture(
			'<div b-name="card"><i b-slot="one">x</i><i b-slot="two">y</i></div>',
		);
		strictEqual(targetAt(file, at('b-slot="one"'), 'b-slot')!.slotName, 'one');
		strictEqual(targetAt(file, at('b-slot="two"'), 'b-slot')!.slotName, 'two');
	});
});

describe('resolveAt — custom element call sites', () => {
	const SRC = [
		'<div b-name="page">',
		'  <my-widget label="hi" :count="n"></my-widget>',
		'</div>',
		'<my-widget b-attr:label b-attr:count>',
		'  <b>{{ label }}</b>',
		'</my-widget>',
	].join('\n');

	it('resolves the call tag', async () => {
		const { file, at } = await fixture(SRC);
		strictEqual(targetAt(file, at('<my-widget label'), 'custom-element')!.node.partialName, 'my-widget');
	});

	it('resolves a call-site attribute, plain or bound', async () => {
		const { file, at } = await fixture(SRC);
		strictEqual(targetAt(file, at('label="hi"'), 'caller-attr')!.attrName, 'label');
		strictEqual(targetAt(file, at(':count="n"'), 'caller-attr')!.attrName, 'count');
	});
});

describe('resolveAt — asset references', () => {
	it('resolves each @name/subpath in a srcset separately', async () => {
		const imagesDir = '/home/developer/BackflipHTML/test/assets/images';
		const { directory } = await compileFiles(
			new Map([['page.html', '<div b-name="page"><img srcset~="@images/photo.jpg 1x, @images/icon.png 2x" /></div>']]),
			{ assetMap: new Map([['images', '/i/']]), assetDirs: new Map([['images', imagesDir]]) },
		);
		const file = directory.files.get('page.html')!;
		const src = '<div b-name="page"><img srcset~="@images/photo.jpg 1x, @images/icon.png 2x" /></div>';

		const photo = targetAt(file, src.indexOf('@images/photo.jpg') + 4, 'asset-ref');
		const icon = targetAt(file, src.indexOf('@images/icon.png') + 4, 'asset-ref');
		strictEqual(photo!.subpath, 'photo.jpg');
		strictEqual(icon!.subpath, 'icon.png');
		strictEqual(photo!.attrName, 'srcset');
		ok(photo!.subpathLoc, 'expected a subpath span');
	});
});
