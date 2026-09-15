/**
 * Completion inside an asset-naming attribute: directory names after `@`, then
 * files and subdirectories once a directory is named.
 *
 * Every item carries its own `textEdit` and `filterText`. Without them a client
 * falls back to the word under the cursor, and no editor's word pattern treats
 * `@name/subpath` as one word: the edit would replace a fragment of the ref and
 * leave the rest in place, and the filter would be matched against a word the
 * `@` has been cut from.
 */

import { CompletionItem, CompletionItemKind } from 'vscode-languageserver';
import { assetRefEditAtCursor } from './asset-attr.js';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

/** Reads a directory. Injectable so tests need no fixture tree on disk. */
export type ReadDir = (dir: string) => Promise<{ name: string; isDirectory: boolean }[]>;

const readDirFromDisk: ReadDir = async dir => {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	return entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() }));
};

/**
 * Completions for the asset reference being typed on `line` at `character`,
 * where `lineNumber` is that line's position in the document. Empty when the
 * cursor is not on a ref in an asset attribute's value.
 */
export async function getAssetCompletions(
	line: string,
	character: number,
	lineNumber: number,
	assetDirs: Map<string, string>,
	readDir: ReadDir = readDirFromDisk,
): Promise<CompletionItem[]> {
	const ref = assetRefEditAtCursor(line, character);
	if (!ref) return [];

	const range = {
		start: { line: lineNumber, character: ref.start },
		end: { line: lineNumber, character: ref.end },
	};
	// The label names the entry; the whole ref is what gets filtered and written.
	const item = (label: string, kind: CompletionItemKind, newText: string): CompletionItem => ({
		label,
		kind,
		filterText: newText,
		textEdit: { range, newText },
	});

	// A ref without a `/` is still naming its asset directory. The `@` is
	// optional throughout: it belongs at the front of every value, so a ref
	// missing it is one being typed, and the completion writes it in.
	const named = ref.typed.match(/^@?([a-zA-Z0-9_-]+)\/(.*)$/);
	if (!named) {
		const prefix = ref.typed.replace(/^@/, '');
		return Array.from(assetDirs.keys())
			.filter(name => name.startsWith(prefix))
			.map(name => item(`@${name}/`, CompletionItemKind.Folder, `@${name}/`));
	}

	const [, dirName, subpath] = named;
	const dirPath = assetDirs.get(dirName);
	if (!dirPath) return [];

	// Split at the last `/`: what precedes it is the directory to list, what
	// follows is the partial name being typed — empty when the subpath ends there.
	const cut = subpath.lastIndexOf('/');
	const parent = cut === -1 ? '' : subpath.substring(0, cut);
	const prefix = subpath.substring(cut + 1);
	let entries;
	try {
		entries = await readDir(path.join(dirPath, parent));
	} catch {
		return [];
	}

	const items: CompletionItem[] = [];
	for (const entry of entries) {
		if (!entry.name.startsWith(prefix)) continue;
		if (entry.name.startsWith('.')) continue;
		const relBase = parent ? `${parent}/${entry.name}` : entry.name;
		items.push(entry.isDirectory
			? item(`${entry.name}/`, CompletionItemKind.Folder, `@${dirName}/${relBase}/`)
			: item(entry.name, CompletionItemKind.File, `@${dirName}/${relBase}`));
	}
	return items;
}
