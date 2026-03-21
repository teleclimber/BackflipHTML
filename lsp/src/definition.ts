import { Location } from 'vscode-languageserver';
import type { ProjectIndex } from './index.js';

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
