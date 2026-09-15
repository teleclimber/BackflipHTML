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
