/**
 * What can be written at the cursor: an asset path, a `b-part` target, a custom
 * element partial tag, a slot name in `b-in`, or a `b-store:` on a partial definition.
 *
 * Every item carries its own `textEdit` and `filterText`. Without them a client
 * falls back to the word under the cursor, and no editor's word pattern treats
 * `@name/subpath` or `path/file.html#name` as one word: the edit would replace
 * a fragment and leave the rest in place, and the filter would be matched
 * against a word the `@` or `#` has been cut from.
 *
 * Each probe reads the line's text through `tag-context.ts`, so it answers
 * while the value is still being typed — before the document compiles, and
 * before the trees the index was built from match what is on screen.
 */

import { CompletionItem, CompletionItemKind } from 'vscode-languageserver';
import type { Position, Range } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { assetRefEditAtCursor } from './asset-attr.js';
import { findEnclosingCallSiteTag, findEnclosingOpeningTag, isDefinitionTag, maskQuoted, openAttrValueEdit, tagNameBeingTyped } from './tag-context.js';
import {
	exportedPartials, partialsInFile, resolveCallTarget, visibleCustomElementDefs,
	type PartialDef, type ProjectIndex,
} from './index.js';
import type { StoreTable } from '@backflip/html';
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

// --- partial, custom element and slot completion ---

/**
 * Attribute names, written so a longer name ending in the same text (a
 * `data-b-part`, say) is not mistaken for the directive.
 */
const B_PART = '(?<![\\w-])b-part';
const B_IN = '(?<![\\w-])b-in';
const B_GENERATE = '(?<![\\w-])b-generate';

/** The `b-generate` values, with the one-liner each shows in the completion list. */
const GENERATE_MODES: [string, string][] = [
	['full', 'Generate the element class and register it — no author JS needed'],
	['base', 'Generate an element class to subclass and define yourself'],
	['render', 'Generate the patch class only; you write the whole web component'],
];

/** Re-opens the suggest widget, so picking a file leads straight to its partials. */
const RETRIGGER = { title: 'Suggest partials', command: 'editor.action.triggerSuggest' };

/** "slots: header, footer" — what a definition offers, for an item's detail line. */
function slotDetail(def: PartialDef): string | undefined {
	const slots = Array.from(new Set(def.slots));
	return slots.length > 0 ? `slots: ${slots.join(', ')}` : undefined;
}

/** A new word begins here: the start, an uppercase letter, or after a separator. */
function isWordStart(candidate: string, at: number): boolean {
	if (at === 0) return true;
	const ch = candidate[at];
	if (ch !== ch.toLowerCase()) return true;
	return !/[a-zA-Z0-9]/.test(candidate[at - 1]);
}

/**
 * Where the typed text sits in `candidate`, as a rank — lower is a better
 * match. Null when it is not there at all.
 *
 * `0` opens the candidate, `1` opens a word inside it, `2` is mid-word. The
 * whole typed string has to appear contiguously, so `shell` finds `page-shell`
 * (1) and `PageShell` (1), `hell` finds both mid-word (2), and `pgsl` finds
 * nothing. Case is the one thing ignored.
 *
 * Matching and ranking are one pass because they are one question: a candidate
 * matches where the typed text appears, and how well it matches is where.
 */
export function matchRank(candidate: string, typed: string): 0 | 1 | 2 | null {
	if (typed === '') return 0;
	const low = candidate.toLowerCase();
	const needle = typed.toLowerCase();
	let best: 0 | 1 | 2 | null = null;
	for (let at = low.indexOf(needle); at !== -1; at = low.indexOf(needle, at + 1)) {
		if (at === 0) return 0;
		const rank = isWordStart(candidate, at) ? 1 : 2;
		if (best === null || rank < best) best = rank;
	}
	return best;
}

/** Whether the typed text appears in `candidate` at all. */
export function matchesTyped(candidate: string, typed: string): boolean {
	return matchRank(candidate, typed) !== null;
}

/*
 * Who matches what.
 *
 * `matchesTyped` decides the set, and every item's `filterText` is the text
 * already typed, verbatim, so the client's own pass matches all of them and
 * drops none. The response is marked incomplete (see `server.ts`) so the next
 * keystroke asks again rather than re-filtering the list already in hand.
 *
 * Leaving the filtering to the client instead does not work here, and not only
 * because its matching is fuzzy. A client matches the word it thinks is being
 * typed against one fixed `filterText` per item, and a partial reference is not
 * a word: the same row has to answer to `page-shell`, to `#page-shell` and to
 * `layout.html#page-shell`, so no one value can match what was typed in every
 * form. Where the two disagree the row scores nothing and the item vanishes —
 * and in VS Code, a filtered model that empties while the leading word is empty
 * (which any `-` makes it) cancels the session outright rather than showing a
 * stale list. Every custom element name carries a `-`, so that is not an edge.
 *
 * The cost of deciding it here is the match highlighting in the labels, which
 * the client draws from its own match and so cannot draw from ours.
 */

/**
 * `group`, then `matchRank`, then `tiebreak`. So a name the typed text opens
 * beats one where it opens a word, which beats one where it only appears
 * mid-word, and the rest stay in a stable alphabetical order.
 *
 * A row matched on something other than `matchedOn` — a qualified ref found by
 * its file rather than its name — ranks below every row matched on the name.
 */
function sortKey(group: string, typed: string, matchedOn: string, tiebreak = matchedOn): string {
	return `${group}${matchRank(matchedOn, typed) ?? 3}${tiebreak}`;
}

/**
 * Completions for the `b-part` value being typed on `line` at `character`.
 *
 * A value names a partial in this file (`#name`), or one another file exports
 * (`path/file.html#name`). Before a `#` is typed all three ways in are offered
 * — this file's names, the files that export something, and every exported
 * partial in full — because which one is wanted is not knowable yet, narrowed
 * to the ones whose name or file contains what has been typed. After the `#`,
 * only the names the left-hand side can reach.
 */
export function getPartialCompletions(
	line: string,
	character: number,
	lineNumber: number,
	filePath: string,
	index: ProjectIndex,
): CompletionItem[] {
	const attr = openAttrValueEdit(line, character, B_PART);
	if (!attr) return [];

	const range: Range = {
		start: { line: lineNumber, character: attr.valueStart },
		end: { line: lineNumber, character: attr.valueEnd },
	};
	const typed = attr.typed;
	const item = (
		label: string, newText: string, kind: CompletionItemKind, sortText: string,
		detail?: string, retrigger?: boolean,
	): CompletionItem => {
		const completion: CompletionItem = {
			label,
			kind,
			sortText,
			filterText: typed,
			textEdit: { range, newText },
		};
		if (detail) completion.detail = detail;
		if (retrigger) completion.command = RETRIGGER;
		return completion;
	};

	// Past the `#` the file is settled, so only the name after it is matched.
	const hash = typed.indexOf('#');
	if (hash !== -1) {
		const file = typed.substring(0, hash);
		const name = typed.substring(hash + 1);
		const defs = file === ''
			? partialsInFile(filePath, index)
			: exportedPartials(index).filter(d => d.file === file);
		return defs
			.filter(d => matchesTyped(d.name, name))
			.map(d => item(`${file}#${d.name}`, `${file}#${d.name}`, CompletionItemKind.Struct, sortKey('0', name, d.name), slotDetail(d)));
	}

	const items: CompletionItem[] = [];
	for (const def of partialsInFile(filePath, index)) {
		if (!matchesTyped(def.name, typed)) continue;
		items.push(item(`#${def.name}`, `#${def.name}`, CompletionItemKind.Struct, sortKey('0', typed, def.name), slotDetail(def)));
	}

	const exported = exportedPartials(index).filter(d => d.file !== filePath);
	const byFile = new Map<string, PartialDef[]>();
	for (const def of exported) {
		const group = byFile.get(def.file);
		if (group) group.push(def);
		else byFile.set(def.file, [def]);
	}
	for (const [file, defs] of byFile) {
		if (!matchesTyped(file, typed)) continue;
		items.push(item(`${file}#`, `${file}#`, CompletionItemKind.File, sortKey('1', typed, file), `${defs.length} exported`, true));
	}
	// A qualified ref answers to either half: the partial's name, or its file.
	for (const def of exported) {
		if (!matchesTyped(def.name, typed) && !matchesTyped(def.file, typed)) continue;
		const ref = `${def.file}#${def.name}`;
		items.push(item(ref, ref, CompletionItemKind.Struct, sortKey('2', typed, def.name, ref), slotDetail(def)));
	}
	return items;
}

/**
 * Completions for a custom element partial tag being named at the cursor.
 *
 * Offers what a call in this file can reach — its own definitions plus the
 * exported ones — which is the set `resolveCustomElementCalls` resolves against.
 */
export function getCustomElementCompletions(
	line: string,
	character: number,
	lineNumber: number,
	filePath: string,
	index: ProjectIndex,
): CompletionItem[] {
	const tag = tagNameBeingTyped(line, character);
	if (!tag) return [];

	const range: Range = {
		start: { line: lineNumber, character: tag.start },
		end: { line: lineNumber, character: tag.end },
	};
	return visibleCustomElementDefs(filePath, index)
		.filter(def => matchesTyped(def.name, tag.typed))
		.map(def => {
			const item: CompletionItem = {
				label: def.name,
				kind: CompletionItemKind.Class,
				filterText: tag.typed,
				sortText: sortKey('0', tag.typed, def.name),
				textEdit: { range, newText: def.name },
			};
			const detail = [def.file === filePath ? undefined : def.file, slotDetail(def)].filter(Boolean).join(' · ');
			if (detail) item.detail = detail;
			const attrs = def.bAttrs?.map(a => `${a.name}: ${a.isBool ? 'bool' : 'string'}`) ?? [];
			if (attrs.length > 0) item.documentation = `Attributes — ${attrs.join(', ')}`;
			return item;
		});
}

/**
 * Completions for the `b-in` value being typed: the slots declared by the
 * partial whose call body the tag sits in. Nothing when the tag's parent makes
 * no call — `b-in` routes into a slot only from a direct child of a call body.
 */
export function getSlotCompletions(
	doc: TextDocument,
	position: Position,
	filePath: string,
	index: ProjectIndex,
): CompletionItem[] {
	const line = doc.getText({
		start: { line: position.line, character: 0 },
		end: { line: position.line + 1, character: 0 },
	});
	const attr = openAttrValueEdit(line, position.character, B_IN);
	if (!attr) return [];

	const call = findEnclosingCallSiteTag(doc, position.line, position.character);
	if (!call) return [];
	const { partialName, def } = resolveCallTarget(call, filePath, index);
	if (!def) return [];

	const range: Range = {
		start: { line: position.line, character: attr.valueStart },
		end: { line: position.line, character: attr.valueEnd },
	};
	return Array.from(new Set(def.slots))
		.filter(slot => matchesTyped(slot, attr.typed))
		.map(slot => ({
			label: slot,
			kind: CompletionItemKind.Field,
			detail: `slot of ${partialName}`,
			filterText: attr.typed,
			sortText: sortKey('0', attr.typed, slot),
			textEdit: { range, newText: slot },
		}));
}

/** The three `b-generate` values, offered inside `b-generate="…"`. */
export function getGenerateCompletions(
	line: string,
	character: number,
	lineNumber: number,
): CompletionItem[] {
	const attr = openAttrValueEdit(line, character, B_GENERATE);
	if (!attr) return [];

	const range: Range = {
		start: { line: lineNumber, character: attr.valueStart },
		end: { line: lineNumber, character: attr.valueEnd },
	};
	return GENERATE_MODES
		.filter(([mode]) => matchesTyped(mode, attr.typed))
		.map(([mode, detail]) => ({
			label: mode,
			kind: CompletionItemKind.EnumMember,
			detail,
			filterText: attr.typed,
			sortText: sortKey('0', attr.typed, mode),
			textEdit: { range, newText: mode },
		}));
}

/**
 * `b-store:NAME` for each declared store, offered while an attribute name is typed
 * on a partial definition tag. A store the tag already declares is left out.
 */
export function getStoreCompletions(
	doc: TextDocument,
	position: Position,
	stores: StoreTable,
): CompletionItem[] {
	const line = doc.getText({ start: { line: position.line, character: 0 }, end: { line: position.line + 1, character: 0 } });
	const m = line.substring(0, position.character).match(/(?<=\s)[\w:.-]*$/);
	if (!m || m.index === undefined) return [];
	const tag = findEnclosingOpeningTag(doc, position.line, position.character);
	if (!tag || !isDefinitionTag(doc, tag)) return [];
	// The cursor must be between attributes, not inside a quoted value.
	const upToCursor = tag.openTagText.substring(0, doc.offsetAt(position) - tag.startOffset);
	if (/["']/.test(maskQuoted(upToCursor))) return [];

	const typed = m[0];
	const ahead = line.substring(position.character).match(/^[\w:.-]*/)![0];
	const range: Range = {
		start: { line: position.line, character: m.index },
		end: { line: position.line, character: position.character + ahead.length },
	};
	const declared = new Set([...tag.openTagText.matchAll(/\sb-store:([\w$]+)/g)].map(d => d[1]));
	return [...stores.values()]
		.filter(s => !declared.has(s.name))
		.map(s => `b-store:${s.name}`)
		.filter(label => matchesTyped(label, typed))
		.map(label => ({
			label,
			kind: CompletionItemKind.Property,
			detail: 'store',
			filterText: typed,
			sortText: sortKey('0', typed, label),
			textEdit: { range, newText: label },
		}));
}

/**
 * Everything offered at the cursor. The probes answer for disjoint positions,
 * so the first that has something to say is the answer.
 */
export async function getCompletions(
	doc: TextDocument,
	position: Position,
	filePath: string,
	index: ProjectIndex,
	assetDirs?: Map<string, string> | null,
	readDir: ReadDir = readDirFromDisk,
	stores?: StoreTable | null,
): Promise<CompletionItem[]> {
	const line = doc.getText({
		start: { line: position.line, character: 0 },
		end: { line: position.line + 1, character: 0 },
	});
	const ch = position.character;

	if (assetDirs && assetDirs.size > 0) {
		const assets = await getAssetCompletions(line, ch, position.line, assetDirs, readDir);
		if (assets.length > 0) return assets;
	}

	const generate = getGenerateCompletions(line, ch, position.line);
	if (generate.length > 0) return generate;

	const partials = getPartialCompletions(line, ch, position.line, filePath, index);
	if (partials.length > 0) return partials;

	const slots = getSlotCompletions(doc, position, filePath, index);
	if (slots.length > 0) return slots;

	if (stores && stores.size > 0) {
		const storeItems = getStoreCompletions(doc, position, stores);
		if (storeItems.length > 0) return storeItems;
	}

	return getCustomElementCompletions(line, ch, position.line, filePath, index);
}
