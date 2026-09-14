import { Location } from 'vscode-languageserver';
import type { ProjectIndex } from './index.js';
import * as path from 'node:path';
import { assetRefAtCursor } from './asset-attr.js';

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
 * Given a custom element partial tag name, find the definition location.
 * Custom element partial names are globally unique, so no targetFile is needed.
 */
export function findCustomElementDefinition(
	tagName: string,
	index: ProjectIndex,
	workspaceRoot: string,
): Location | null {
	const defs = index.partialDefs.get(tagName);
	if (!defs || defs.length === 0) return null;
	const def = defs.find(d => d.customElement);
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
