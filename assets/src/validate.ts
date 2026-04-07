import * as fs from 'node:fs';
import * as path from 'node:path';
import { BackflipError } from '@backflip/html';
import type { AssetReference } from './types.js';

/**
 * Validate that asset files referenced in templates physically exist on disk.
 * Returns a list of BackflipError objects for missing files.
 */
export function validateAssetFiles(
	refs: AssetReference[],
	assetDirs: Map<string, string>
): BackflipError[] {
	const errors: BackflipError[] = [];

	for (const ref of refs) {
		const dir = assetDirs.get(ref.assetName);
		if (!dir) {
			// Syntax validation in compiler should have caught unknown directories,
			// but we skip here if not found in the provided map.
			continue;
		}

		const filePath = path.join(dir, ref.assetSubpath);
		try {
			fs.statSync(filePath);
		} catch {
			errors.push(new BackflipError(
				`asset file not found: @${ref.assetName}/${ref.assetSubpath}`,
				{
					filename: ref.sourceFile,
					line: ref.line,
					col: ref.column,
				}
			));
		}
	}

	return errors;
}
