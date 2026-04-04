import { discoverAssetFiles } from '@backflip/assets';

export interface CssFileRef {
	/** Asset directory name (from config). */
	name: string;
	/** Relative path within the asset directory. */
	subpath: string;
	/** Absolute path on disk. */
	absolutePath: string;
}

/**
 * Scan configured asset directories for CSS files.
 * Returns all *.css files found, with their asset name and subpath.
 */
export function discoverCssFiles(assetDirs: Map<string, string>): CssFileRef[] {
	return discoverAssetFiles(assetDirs, f => f.endsWith('.css'));
}
