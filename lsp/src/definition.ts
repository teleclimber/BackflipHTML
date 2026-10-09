import { Location } from 'vscode-languageserver';
import type { ProjectIndex } from './index.js';
import { visibleCustomElementDef } from './index.js';
import * as path from 'node:path';
import { assetRefAtCursor } from './asset-attr.js';
import type { StoreAtCursor } from './stores.js';
import type { SourceLoc } from '@backflip/html';

/**
 * Given a partial reference (b-part), find the definition location (b-name).
 * Returns the Location of the b-name attribute, or null if not found.
 */
export function findDefinition(
	partialName: string,
	targetFile: string | null,
	sourceFile: string,
	index: ProjectIndex,
	workspaceRoot: string,
): Location | null {
	const defs = index.partialDefs.get(partialName);
	if (!defs || defs.length === 0) return null;

	// Find the matching definition
	const resolvedFile = targetFile ?? sourceFile;
	const def = defs.find(d => d.file === resolvedFile);
	if (!def || !def.loc) return null;

	const uri = `file://${workspaceRoot}/${def.file}`;
	return {
		uri,
		range: {
			start: {
				line: def.loc.startLine - 1,
				character: def.loc.startCol - 1,
			},
			end: {
				line: def.loc.endLine - 1,
				character: def.loc.endCol - 1,
			},
		},
	};
}

/**
 * Given a custom element partial tag name written in `sourceFile`, find the
 * definition location — the one that file's call resolves to.
 */
export function findCustomElementDefinition(
	tagName: string,
	sourceFile: string,
	index: ProjectIndex,
	workspaceRoot: string,
): Location | null {
	const def = visibleCustomElementDef(tagName, sourceFile, index);
	if (!def || !def.loc) return null;

	const uri = `file://${workspaceRoot}/${def.file}`;
	return {
		uri,
		range: {
			start: {
				line: def.loc.startLine - 1,
				character: def.loc.startCol - 1,
			},
			end: {
				line: def.loc.endLine - 1,
				character: def.loc.endCol - 1,
			},
		},
	};
}

/**
 * Given a cursor position on an asset reference (@name/subpath),
 * resolve to the file location on disk.
 */
export function findAssetDefinition(
	line: string,
	character: number,
	assetDirs: Map<string, string>,
): Location | null {
	const ref = assetRefAtCursor(line, character);
	if (!ref) return null;

	const dirPath = assetDirs.get(ref.name);
	if (!dirPath) return null;

	return {
		uri: `file://${path.join(dirPath, ref.subpath)}`,
		range: {
			start: { line: 0, character: 0 },
			end: { line: 0, character: 0 },
		},
	};
}

/**
 * Where a store under the cursor is defined: a store variable goes to its partial's
 * `b-store:` attribute in `docUri`, a `b-store:` attribute to the store file.
 */
export function findStoreDefinition(at: StoreAtCursor, docUri: string): Location | null {
	if (at.kind === 'variable') return { uri: docUri, range: locRange(at.declaration.loc) };
	if (!at.store) return null;
	return { uri: `file://${at.store.file}`, range: locRange(at.store.nameLoc) };
}

function locRange(loc: SourceLoc): Location['range'] {
	return {
		start: { line: loc.startLine - 1, character: loc.startCol - 1 },
		end: { line: loc.endLine - 1, character: loc.endCol - 1 },
	};
}
