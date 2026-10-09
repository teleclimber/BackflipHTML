import type { Position } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { CompiledFile, RootTNode, PartialStore, StoreDecl, StoreTable, SourceLoc } from '@backflip/html';

/**
 * A store under the cursor: a `b-store:NAME` attribute on a partial definition, or
 * the store's variable in an expression of a partial that declares it.
 */
export interface StoreAtCursor {
	kind: 'declaration' | 'variable';
	name: string;
	partialName: string;
	root: RootTNode;
	/** The partial's `b-store:NAME` attribute. */
	declaration: PartialStore & { loc: SourceLoc };
	/** The store, as its store file declares it. */
	store?: StoreDecl;
}

export function storeAtCursor(
	doc: TextDocument, position: Position, file: CompiledFile, stores: StoreTable,
): StoreAtCursor | null {
	const offset = doc.offsetAt(position);
	const enclosing = enclosingPartial(file, offset);
	if (!enclosing) return null;
	const { partialName, root } = enclosing;
	const declared = (root.stores ?? []).filter((s): s is PartialStore & { loc: SourceLoc } => s.loc !== undefined);
	const at = (kind: StoreAtCursor['kind'], declaration: PartialStore & { loc: SourceLoc }): StoreAtCursor => {
		const found: StoreAtCursor = { kind, name: declaration.name, partialName, root, declaration };
		const store = stores.get(declaration.name);
		if (store) found.store = store;
		return found;
	};

	const onAttr = declared.find(s => offset >= s.loc.startOffset && offset < s.loc.endOffset);
	if (onAttr) return at('declaration', onAttr);

	const line = doc.getText({ start: { line: position.line, character: 0 }, end: { line: position.line + 1, character: 0 } });
	const name = variableAt(line, position.character);
	const declaration = name ? declared.find(s => s.name === name) : undefined;
	return declaration ? at('variable', declaration) : null;
}

// The partial whose definition spans `offset`.
function enclosingPartial(file: CompiledFile, offset: number): { partialName: string; root: RootTNode } | null {
	for (const [partialName, root] of file.partials) {
		if (root.meta && offset >= root.meta.startOffset && offset < root.meta.endOffset) return { partialName, root };
	}
	return null;
}

// `{{ … }}` interpolations, and the values of the attributes that hold an expression.
const EXPRESSION_RE = /\{\{([^{}]*)\}\}|(?<=\s)(?:b-if|b-else-if|b-for|b-data:[\w-]+|b-bind:[\w~-]+|:[\w~-]+)=(?:"([^"]*)"|'([^']*)')/g;

/**
 * The variable at `character` when it sits in an expression on `line`: an identifier
 * that is not a property (`x.name`) and not inside a string literal.
 */
export function variableAt(line: string, character: number): string | null {
	for (const m of line.matchAll(EXPRESSION_RE)) {
		const text = m[1] ?? m[2] ?? m[3] ?? '';
		const start = m.index! + m[0].length - text.length - (m[1] !== undefined ? 2 : 1);
		if (character < start || character > start + text.length) continue;
		const at = character - start;
		let from = at;
		while (from > 0 && /[\w$]/.test(text[from - 1])) from--;
		let to = at;
		while (to < text.length && /[\w$]/.test(text[to])) to++;
		const word = text.slice(from, to);
		if (!/^[A-Za-z_$][\w$]*$/.test(word)) return null;
		if (/\.\s*$/.test(text.slice(0, from))) return null;
		const quotes = (text.slice(0, from).match(/['"`]/g) ?? []).length;
		return quotes % 2 === 0 ? word : null;
	}
	return null;
}
