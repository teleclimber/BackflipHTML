import { Location } from 'vscode-languageserver';
import type { ProjectIndex } from './index.js';
import * as path from 'node:path';

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
 * Given a cursor position on an asset reference (@name/subpath),
 * resolve to the file location on disk.
 */
export function findAssetDefinition(
	line: string,
	character: number,
	assetDirs: Map<string, string>,
): Location | null {
	// Match attributes with ~ suffix: attr~="value" or attr~='value' or :attr~="..."
	const regex = /:?([a-zA-Z][a-zA-Z0-9-]*)~=(["'])([^"']*)\2/g;
	let m;
	while ((m = regex.exec(line)) !== null) {
		const quote = m[2];
		const valueStart = m.index + m[0].indexOf(quote) + 1;
		const valueEnd = valueStart + m[3].length;
		if (character < valueStart || character > valueEnd) continue;

		const attrName = m[1];
		const value = m[3];

		// Find which @name/subpath the cursor is on
		const assetRefRegex = /@([a-zA-Z0-9_-]+)\//g;
		let refMatch;
		while ((refMatch = assetRefRegex.exec(value)) !== null) {
			const refStart = valueStart + refMatch.index;
			const afterRef = refMatch.index + refMatch[0].length;
			const rest = value.substring(afterRef);
			const subpath = attrName === 'srcset'
				? rest.split(',')[0].split(/\s/)[0]
				: rest;
			const refEnd = valueStart + afterRef + subpath.length;

			if (character >= refStart && character <= refEnd) {
				const dirName = refMatch[1];
				const dirPath = assetDirs.get(dirName);
				if (!dirPath) return null;

				const filePath = path.join(dirPath, subpath);
				const uri = `file://${filePath}`;
				return {
					uri,
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 0 },
					},
				};
			}
		}
	}

	return null;
}
