import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { CompletionItemKind, TextEdit } from 'vscode-languageserver';
import { getAssetCompletions, type ReadDir } from './completion.js';

const assetDirs = new Map([
	['assets', '/ws/assets'],
	['images', '/ws/images'],
]);

const tree: Record<string, { name: string; isDirectory: boolean }[]> = {
	'/ws/assets': [
		{ name: 'style.css', isDirectory: false },
		{ name: 'stamp.svg', isDirectory: false },
		{ name: 'sub', isDirectory: true },
		{ name: '.hidden', isDirectory: false },
	],
	'/ws/assets/sub': [{ name: 'deep.css', isDirectory: false }],
	'/ws/images': [{ name: 'a.png', isDirectory: false }],
};

const readDir: ReadDir = async dir => {
	const entries = tree[dir];
	if (!entries) throw new Error(`ENOENT: ${dir}`);
	return entries;
};

/** Completions for a line whose cursor is written as `|`. */
function complete(marked: string) {
	const character = marked.indexOf('|');
	const line = marked.replace('|', '');
	return getAssetCompletions(line, character, 7, assetDirs, readDir);
}

/** The `[start, end]` columns an item replaces. */
function edited(item: { textEdit?: TextEdit | unknown }): [number, number] {
	const edit = item.textEdit as TextEdit | undefined;
	if (!edit) throw new Error('item carries no textEdit');
	strictEqual(edit.range.start.line, 7);
	strictEqual(edit.range.end.line, 7);
	return [edit.range.start.character, edit.range.end.character];
}

describe('getAssetCompletions — what the item replaces', () => {
	it('replaces nothing in an empty value, writing the ref at the cursor', async () => {
		const marked = '<img src~="|">';
		const items = await complete(marked);
		const item = items.find(i => i.label === '@assets/')!;
		deepStrictEqual(edited(item), [marked.indexOf('|'), marked.indexOf('|')]);
		strictEqual((item.textEdit as TextEdit).newText, '@assets/');
	});

	it('replaces the `@` when only it has been typed', async () => {
		const marked = '<img src~="@|">';
		const items = await complete(marked);
		const item = items.find(i => i.label === '@assets/')!;
		deepStrictEqual(edited(item), [marked.indexOf('@'), marked.indexOf('|')]);
		strictEqual((item.textEdit as TextEdit).newText, '@assets/');
	});

	it('replaces the whole `@name` while the directory name is being typed', async () => {
		const marked = '<img src~="@as|">';
		const items = await complete(marked);
		const item = items.find(i => i.label === '@assets/')!;
		deepStrictEqual(edited(item), [marked.indexOf('@'), marked.indexOf('|')]);
		strictEqual((item.textEdit as TextEdit).newText, '@assets/');
	});

	it('replaces the whole `@name/subpath` while a file name is being typed', async () => {
		const marked = '<img src~="@assets/st|">';
		const items = await complete(marked);
		const item = items.find(i => i.label === 'style.css')!;
		deepStrictEqual(edited(item), [marked.indexOf('@'), marked.indexOf('|')]);
		strictEqual((item.textEdit as TextEdit).newText, '@assets/style.css');
	});

	it('replaces the whole `@name/` when the subpath is still empty', async () => {
		const marked = '<img src~="@assets/|">';
		const items = await complete(marked);
		const item = items.find(i => i.label === 'style.css')!;
		deepStrictEqual(edited(item), [marked.indexOf('@'), marked.indexOf('|')]);
		strictEqual((item.textEdit as TextEdit).newText, '@assets/style.css');
	});

	it('replaces to the end of a ref being edited from the middle', async () => {
		const marked = '<img src~="@assets/st|yle.css">';
		const items = await complete(marked);
		const item = items.find(i => i.label === 'stamp.svg')!;
		const line = marked.replace('|', '');
		deepStrictEqual(edited(item), [line.indexOf('@'), line.indexOf('.css') + '.css'.length]);
		strictEqual((item.textEdit as TextEdit).newText, '@assets/stamp.svg');
	});

	it('replaces only the candidate being typed in a srcset', async () => {
		const marked = '<img srcset~="@images/a.png 1x, @im|">';
		const items = await complete(marked);
		const item = items.find(i => i.label === '@images/')!;
		deepStrictEqual(edited(item), [marked.lastIndexOf('@'), marked.indexOf('|')]);
	});

	it('replaces only the candidate being edited in a srcset, stopping at its descriptor', async () => {
		const marked = '<img srcset~="@images/a|.png 1x, @images/b.png 2x">';
		const items = await complete(marked);
		const item = items.find(i => i.label === 'a.png')!;
		const line = marked.replace('|', '');
		deepStrictEqual(edited(item), [line.indexOf('@'), line.indexOf('.png') + '.png'.length]);
		strictEqual((item.textEdit as TextEdit).newText, '@images/a.png');
	});
});

describe('getAssetCompletions — what the client filters on', () => {
	it('filters a directory name on the text from the `@`', async () => {
		const items = await complete('<img src~="@as|">');
		strictEqual(items.find(i => i.label === '@assets/')!.filterText, '@assets/');
	});

	it('filters a file on the whole `@name/subpath`, not the bare file name', async () => {
		const items = await complete('<img src~="@assets/st|">');
		strictEqual(items.find(i => i.label === 'style.css')!.filterText, '@assets/style.css');
	});

	it('filters a subdirectory on the whole `@name/subpath`', async () => {
		const items = await complete('<img src~="@assets/s|">');
		strictEqual(items.find(i => i.label === 'sub/')!.filterText, '@assets/sub/');
	});
});

describe('getAssetCompletions — what is offered', () => {
	it('offers every asset dir on a bare `@`', async () => {
		const items = await complete('<img src~="@|">');
		deepStrictEqual(items.map(i => i.label).sort(), ['@assets/', '@images/']);
		strictEqual(items[0].kind, CompletionItemKind.Folder);
	});

	it('narrows asset dirs by what has been typed', async () => {
		const items = await complete('<img src~="@as|">');
		deepStrictEqual(items.map(i => i.label), ['@assets/']);
	});

	it('offers files and subdirectories of a named dir', async () => {
		const items = await complete('<img src~="@assets/|">');
		deepStrictEqual(items.map(i => i.label).sort(), ['stamp.svg', 'style.css', 'sub/']);
	});

	it('narrows entries by the partial file name, and hides dotfiles', async () => {
		const items = await complete('<img src~="@assets/st|">');
		deepStrictEqual(items.map(i => i.label).sort(), ['stamp.svg', 'style.css']);
	});

	it('descends into a subdirectory', async () => {
		const items = await complete('<img src~="@assets/sub/|">');
		deepStrictEqual(items.map(i => i.label), ['deep.css']);
		strictEqual((items[0].textEdit as TextEdit).newText, '@assets/sub/deep.css');
	});

	it('narrows entries inside a subdirectory', async () => {
		const items = await complete('<img src~="@assets/sub/de|">');
		deepStrictEqual(items.map(i => i.label), ['deep.css']);
		strictEqual((items[0].textEdit as TextEdit).newText, '@assets/sub/deep.css');
	});

	it('offers every asset dir in an empty value', async () => {
		deepStrictEqual((await complete('<img src~="|">')).map(i => i.label).sort(), ['@assets/', '@images/']);
		deepStrictEqual((await complete('<my-widget b-script="|">')).map(i => i.label).sort(), ['@assets/', '@images/']);
	});

	it('offers every asset dir at an empty srcset candidate', async () => {
		const items = await complete('<img srcset~="@images/a.png 1x, |">');
		deepStrictEqual(items.map(i => i.label).sort(), ['@assets/', '@images/']);
	});

	it('narrows asset dirs by a name typed without its `@`', async () => {
		const items = await complete('<img src~="as|">');
		deepStrictEqual(items.map(i => i.label), ['@assets/']);
	});

	it('offers entries for a subpath typed without its `@`', async () => {
		const items = await complete('<img src~="assets/st|">');
		deepStrictEqual(items.map(i => i.label).sort(), ['stamp.svg', 'style.css']);
	});

	it('offers nothing on a srcset descriptor', async () => {
		deepStrictEqual(await complete('<img srcset~="@images/a.png 1x|">'), []);
	});

	it('offers candidates for b-script, which names an asset without `~`', async () => {
		const items = await complete('<my-widget b-script="@assets/st|">');
		deepStrictEqual(items.map(i => i.label).sort(), ['stamp.svg', 'style.css']);
	});

	it('offers nothing outside an asset attribute', async () => {
		deepStrictEqual(await complete('<img src="@|">'), []);
		deepStrictEqual(await complete('<img src~="@assets/x.png" alt="@|">'), []);
	});

	it('offers nothing for an unknown asset dir', async () => {
		deepStrictEqual(await complete('<img src~="@nope/|">'), []);
	});
});

// --- partial, custom element and slot completion ---

import { compileFiles } from '@backflip/html';
import { buildIndex } from './index.js';
import { makeDoc, makeIndex, makeLoc } from './test-helpers.js';
import {
	getCompletions, getCustomElementCompletions, getPartialCompletions, getSlotCompletions,
} from './completion.js';

const COMPONENTS = [
	'<div b-name="banner" b-export>Banner</div>',
	'<div b-name="secret">Local only</div>',
	'<my-chip b-export><b-unwrap b-slot="label" /></my-chip>',
	'<my-local>Local element</my-local>',
].join('\n');

/**
 * Completions at the `|` in `marked`, from an index compiled out of that very
 * text — the editor and the index agree, as they do just after a save.
 */
async function completeIn(
	marked: string[], file = 'page.html', others: Record<string, string> = { 'components.html': COMPONENTS },
) {
	let line = -1;
	let character = -1;
	const cleaned = marked.map((text, i) => {
		const at = text.indexOf('|');
		if (at !== -1) {
			line = i;
			character = at;
		}
		return text.replace('|', '');
	});
	const templateFiles = new Map(Object.entries({ ...others, [file]: cleaned.join('\n') }));
	const { directory } = await compileFiles(templateFiles);
	return getCompletions(makeDoc(cleaned), { line, character }, file, buildIndex(directory), null);
}

/** Labels, sorted the way the client would sort them. */
function labels(items: { label: string; sortText?: string }[]): string[] {
	return [...items]
		.sort((a, b) => (a.sortText ?? a.label).localeCompare(b.sortText ?? b.label))
		.map(i => i.label);
}

describe('getPartialCompletions', () => {
	it('offers this file\'s partials, the files that export, and every exported partial', async () => {
		const items = await completeIn([
			'<div b-name="page">',
			'  <div b-part="|"></div>',
			'</div>',
			'<div b-name="card"></div>',
		]);
		deepStrictEqual(labels(items), [
			'#card',
			'#page',
			'components.html#',
			'components.html#banner',
			'components.html#my-chip',
		]);
	});

	it('leaves out a partial another file does not export', async () => {
		const items = await completeIn([
			'<div b-name="page">',
			'  <div b-part="|"></div>',
			'</div>',
		]);
		strictEqual(items.find(i => i.label.includes('secret')), undefined);
	});

	it('offers only this file\'s partials after a bare `#`', async () => {
		const items = await completeIn([
			'<div b-name="page">',
			'  <div b-part="#|"></div>',
			'</div>',
			'<div b-name="card"></div>',
		]);
		deepStrictEqual(labels(items), ['#card', '#page']);
	});

	it('offers a named file\'s exported partials after its `#`', async () => {
		const items = await completeIn([
			'<div b-name="page">',
			'  <div b-part="components.html#|"></div>',
			'</div>',
		]);
		deepStrictEqual(labels(items), ['components.html#banner', 'components.html#my-chip']);
	});

	it('writes the whole value, replacing what is already typed', async () => {
		const items = await completeIn([
			'<div b-name="page">',
			'  <div b-part="#ca|rd"></div>',
			'</div>',
			'<div b-name="card"></div>',
		]);
		const item = items.find(i => i.label === '#card')!;
		const edit = item.textEdit as TextEdit;
		const line = '  <div b-part="#card"></div>';
		deepStrictEqual(
			[edit.range.start.character, edit.range.end.character],
			[line.indexOf('#card'), line.indexOf('#card') + '#card'.length],
		);
		strictEqual(edit.newText, '#card');
	});

	it('writes the `#` in for a name typed without one', async () => {
		const items = await completeIn([
			'<div b-name="page">',
			'  <div b-part="ca|"></div>',
			'</div>',
			'<div b-name="card"></div>',
		]);
		const item = items.find(i => i.label === '#card')!;
		strictEqual((item.textEdit as TextEdit).newText, '#card');
	});

	it('matches a name anywhere inside it, but never across gaps', async () => {
		const shell = ['<div b-name="page">', '  <div b-part="@"></div>', '</div>', '<div b-name="page-shell"></div>'];
		const at = (typed: string) => completeIn(shell.map(l => l.replace('@', `${typed}|`)));
		// `#page` too: the fixture's own partial is named `page`.
		deepStrictEqual(labels(await at('page')), ['#page', '#page-shell'], 'from the start');
		deepStrictEqual((await at('shell')).map(i => i.label), ['#page-shell'], 'after a separator');
		deepStrictEqual((await at('hell')).map(i => i.label), ['#page-shell'], 'mid-word');
		deepStrictEqual((await at('e-sh')).map(i => i.label), ['#page-shell'], 'mid-word across a separator');
		deepStrictEqual((await at('pgsl')).map(i => i.label), [], 'gaps');
		deepStrictEqual((await at('pagex')).map(i => i.label), [], 'not present');
	});

	it('matches without regard to case', async () => {
		const shell = ['<div b-name="page">', '  <div b-part="@"></div>', '</div>', '<div b-name="PageShell"></div>'];
		const at = (typed: string) => completeIn(shell.map(l => l.replace('@', `${typed}|`)));
		deepStrictEqual((await at('shell')).map(i => i.label), ['#PageShell'], 'at the camelCase hump');
		deepStrictEqual((await at('SHELL')).map(i => i.label), ['#PageShell'], 'in any case');
		deepStrictEqual((await at('ell')).map(i => i.label), ['#PageShell'], 'past the hump');
	});

	it('matches the name after a `#`, not the whole value', async () => {
		const items = await completeIn([
			'<div b-name="page">',
			'  <div b-part="#shell|"></div>',
			'</div>',
			'<div b-name="page-shell"></div>',
		]);
		deepStrictEqual(items.map(i => i.label), ['#page-shell']);
	});

	it('matches a qualified ref by its file as well as its name', async () => {
		const byName = await completeIn([
			'<div b-name="page">',
			'  <div b-part="bann|"></div>',
			'</div>',
		]);
		deepStrictEqual(byName.map(i => i.label), ['components.html#banner']);

		const byFile = await completeIn([
			'<div b-name="page">',
			'  <div b-part="comp|"></div>',
			'</div>',
		]);
		deepStrictEqual(labels(byFile), [
			'components.html#',
			'components.html#banner',
			'components.html#my-chip',
		]);
	});

	it('ranks by where the match lands: opening, then a word, then mid-word', async () => {
		const items = await completeIn([
			'<div b-name="page">',
			'  <div b-part="shell|"></div>',
			'</div>',
			'<div b-name="bombshell"></div>',
			'<div b-name="page-shell"></div>',
			'<div b-name="shell-box"></div>',
		]);
		deepStrictEqual(labels(items), ['#shell-box', '#page-shell', '#bombshell']);
	});

	it('claims the typed text as its filter, so the client cannot drop it', async () => {
		const items = await completeIn([
			'<div b-name="page">',
			'  <div b-part="shel|"></div>',
			'</div>',
			'<div b-name="page-shell"></div>',
		]);
		deepStrictEqual(items.map(i => i.filterText), ['shel']);
		deepStrictEqual(items.map(i => (i.textEdit as TextEdit).newText), ['#page-shell']);
	});

	it('claims a typed text that carries separators, which no name would match', async () => {
		const at = (typed: string) => completeIn([
			'<div b-name="page">',
			`  <div b-part="${typed}|"></div>`,
			'</div>',
			'<div b-name="page-shell"></div>',
		]);
		// A trailing `-`, and the two qualified forms: each has to filter as itself.
		deepStrictEqual((await at('page-')).map(i => i.filterText), ['page-']);
		deepStrictEqual((await at('#page-')).map(i => i.filterText), ['#page-']);
	});

	it('offers nothing outside a b-part value', async () => {
		deepStrictEqual(await completeIn(['<div b-name="page" class="|"></div>']), []);
		deepStrictEqual(await completeIn(['<div b-name="page" data-b-part="|"></div>']), []);
	});

	it('names each item\'s slots so the list says what can be filled', () => {
		const index = makeIndex([
			{ file: 'page.html', name: 'card', loc: makeLoc(1, 1, 1, 5), exported: false, slots: ['header', 'default'] },
		], []);
		const items = getPartialCompletions('  <div b-part="#">', 16, 3, 'page.html', index);
		strictEqual(items.find(i => i.label === '#card')?.detail, 'slots: header, default');
	});
});

describe('getCustomElementCompletions', () => {
	it('offers the custom element partials a call in this file can reach', async () => {
		const items = await completeIn([
			'<div b-name="page">',
			'  <my-|',
			'</div>',
		]);
		deepStrictEqual(items.map(i => i.label), ['my-chip']);
	});

	it('offers a file its own unexported custom elements', async () => {
		const items = await completeIn(
			[
				'<my-chip b-export><b-unwrap b-slot="label" /></my-chip>',
				'<my-local>Local element</my-local>',
				'<div b-name="page">',
				'  <my-|',
				'</div>',
			],
			'components.html',
			{},
		);
		deepStrictEqual(items.map(i => i.label).sort(), ['my-chip', 'my-local']);
	});

	it('replaces the whole tag name being edited', () => {
		const index = makeIndex([
			{ file: 'components.html', name: 'my-card', loc: makeLoc(1, 1, 1, 9), exported: true, customElement: true },
		], []);
		const items = getCustomElementCompletions('  <my-card>', 6, 4, 'page.html', index);
		const edit = items[0].textEdit as TextEdit;
		deepStrictEqual([edit.range.start.character, edit.range.end.character], [3, 10]);
		strictEqual(edit.newText, 'my-card');
	});

	it('offers nothing where no tag is being named', async () => {
		deepStrictEqual(await completeIn(['<div b-name="page">', '  <div class="x">|', '</div>']), []);
	});

	it('matches a tag name anywhere inside it, in any case, but never across gaps', async () => {
		const components = '<page-shell b-export>S</page-shell>\n<my-chip b-export>C</my-chip>';
		const at = (typed: string) => completeIn(
			['<div b-name="page">', `  <${typed}|`, '</div>'],
			'page.html',
			{ 'components.html': components },
		);
		deepStrictEqual((await at('shell')).map(i => i.label), ['page-shell']);
		deepStrictEqual((await at('SHELL')).map(i => i.label), ['page-shell']);
		deepStrictEqual((await at('pgsl')).map(i => i.label), []);
	});
});

describe('getSlotCompletions', () => {
	it('offers the slots of the enclosing b-part call', async () => {
		const items = await completeIn([
			'<div b-name="page">',
			'  <div b-part="#card">',
			'    <b-unwrap b-in="|"></b-unwrap>',
			'  </div>',
			'</div>',
			'<div b-name="card">',
			'  <b-unwrap b-slot="header" />',
			'  <b-unwrap b-slot />',
			'</div>',
		]);
		deepStrictEqual(items.map(i => i.label).sort(), ['default', 'header']);
		strictEqual(items[0].detail, 'slot of card');
	});

	it('offers the slots of the enclosing custom element call', async () => {
		const items = await completeIn([
			'<div b-name="page">',
			'  <my-chip>',
			'    <b-unwrap b-in="|"></b-unwrap>',
			'  </my-chip>',
			'</div>',
		]);
		deepStrictEqual(items.map(i => i.label), ['label']);
		strictEqual(items[0].detail, 'slot of my-chip');
	});

	it('offers nothing when the parent element makes no call', async () => {
		deepStrictEqual(await completeIn([
			'<div b-name="page">',
			'  <div class="wrap">',
			'    <b-unwrap b-in="|"></b-unwrap>',
			'  </div>',
			'</div>',
		]), []);
	});

	it('matches a slot name anywhere inside it, but never across gaps', async () => {
		const page = (typed: string) => [
			'<div b-name="page">',
			'  <div b-part="#card">',
			`    <b-unwrap b-in="${typed}|"></b-unwrap>`,
			'  </div>',
			'</div>',
			'<div b-name="card">',
			'  <b-unwrap b-slot="header" />',
			'  <b-unwrap b-slot="sub-header" />',
			'</div>',
		];
		deepStrictEqual((await completeIn(page('head'))).map(i => i.label).sort(), ['header', 'sub-header']);
		deepStrictEqual((await completeIn(page('sub'))).map(i => i.label), ['sub-header']);
		deepStrictEqual((await completeIn(page('ead'))).map(i => i.label).sort(), ['header', 'sub-header'], 'mid-word');
		deepStrictEqual((await completeIn(page('hdr'))).map(i => i.label), [], 'gaps');
	});

	it('replaces the whole slot name being edited', () => {
		const index = makeIndex([
			{ file: 'page.html', name: 'card', loc: makeLoc(1, 1, 1, 5), exported: false, slots: ['header'] },
		], []);
		const doc = makeDoc([
			'<div b-part="#card">',
			'  <b-unwrap b-in="head"></b-unwrap>',
		]);
		const items = getSlotCompletions(doc, { line: 1, character: 21 }, 'page.html', index);
		const edit = items[0].textEdit as TextEdit;
		deepStrictEqual([edit.range.start.character, edit.range.end.character], [18, 22]);
		strictEqual(edit.newText, 'header');
	});
});
