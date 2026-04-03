import { Location } from 'vscode-languageserver';
import type { ProjectIndex } from './index.js';
import * as path from 'node:path';

/**
 * Given a partial definition name, find all reference locations (b-part usages).
 */
export function findReferences(
	partialName: string,
	defFile: string,
	index: ProjectIndex,
	workspaceRoot: string,
): Location[] {
	const locations: Location[] = [];

	for (const ref of index.partialRefs) {
		if (ref.partialName !== partialName) continue;

		// Match same-file refs (targetFile === null and ref is in same file)
		// or cross-file refs (targetFile === defFile)
		const isMatch = ref.targetFile === null
			? ref.file === defFile
			: ref.targetFile === defFile;

		if (!isMatch) continue;
		if (!ref.loc) continue;

		locations.push({
			uri: `file://${workspaceRoot}/${ref.file}`,
			range: {
				start: {
					line: ref.loc.startLine - 1,
					character: ref.loc.startCol - 1,
				},
				end: {
					line: ref.loc.endLine - 1,
					character: ref.loc.endCol - 1,
				},
			},
		});
	}

	return locations;
}

/**
 * Given a cursor on an asset reference, extract the @name/subpath being referenced.
 * Returns { name, subpath } or null.
 */
export function parseAssetRefAtCursor(
	line: string,
	character: number,
): { name: string; subpath: string } | null {
	const regex = /:?([a-zA-Z][a-zA-Z0-9-]*)~=(["'])([^"']*)\2/g;
	let m;
	while ((m = regex.exec(line)) !== null) {
		const quote = m[2];
		const valueStart = m.index + m[0].indexOf(quote) + 1;
		const valueEnd = valueStart + m[3].length;
		if (character < valueStart || character > valueEnd) continue;

		const attrName = m[1];
		const value = m[3];

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
				return { name: refMatch[1], subpath };
			}
		}
	}

	return null;
}

/**
 * Find all locations in template files that reference a specific asset (@name/subpath).
 */
export function findAssetReferences(
	assetName: string,
	assetSubpath: string,
	templateFiles: Map<string, string>,
	templateRoot: string,
): Location[] {
	const locations: Location[] = [];
	const searchStr = `@${assetName}/${assetSubpath}`;

	for (const [filePath, content] of templateFiles) {
		const lines = content.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			// Only look inside ~ attributes
			if (!line.includes('~=') || !line.includes(searchStr)) continue;

			let col = line.indexOf(searchStr);
			while (col !== -1) {
				locations.push({
					uri: `file://${templateRoot}/${filePath}`,
					range: {
						start: { line: i, character: col },
						end: { line: i, character: col + searchStr.length },
					},
				});
				col = line.indexOf(searchStr, col + 1);
			}
		}
	}

	return locations;
}
