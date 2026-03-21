import { Location } from 'vscode-languageserver';
import type { ProjectIndex } from './index.js';

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
