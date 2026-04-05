import * as fs from 'node:fs';
import * as path from 'node:path';
import { discoverCssFiles, extractAssetUrlsFromCss } from '@backflip/css';
import type { AssetReference } from './types.js';

/**
 * Collect asset references from all CSS files within configured asset directories.
 */
export function collectCssAssetReferences(
	assetDirs: Map<string, string>,
): AssetReference[] {
	const results: AssetReference[] = [];
	const cssFiles = discoverCssFiles(assetDirs);

	for (const cssRef of cssFiles) {
		let content: string;
		try {
			content = fs.readFileSync(cssRef.absolutePath, 'utf8');
		} catch {
			continue;
		}

		const urls = extractAssetUrlsFromCss(content);
		const baseDir = assetDirs.get(cssRef.name)!;
		const cssFileDir = path.dirname(cssRef.absolutePath);

		for (const urlRef of urls) {
			const url = urlRef.url.trim();

			// Ignore absolute URLs and data URIs
			if (/^(https?:|data:|(?:\/\/?))/.test(url)) {
				continue;
			}

			// Resolve relative path against the CSS file's directory
			const absolutePath = path.resolve(cssFileDir, url);

			// Check if the resolved path is within the base directory of the asset folder
			const relativeToBase = path.relative(baseDir, absolutePath);
			const isInside = !relativeToBase.startsWith('..') && !path.isAbsolute(relativeToBase);

			if (isInside) {
				results.push({
					sourceFile: cssRef.subpath,
					line: urlRef.line,
					column: urlRef.column,
					assetName: cssRef.name,
					assetSubpath: relativeToBase,
				});
			}
		}
	}

	return results;
}
