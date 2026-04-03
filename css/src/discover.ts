import * as fs from 'node:fs';
import * as path from 'node:path';

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
	const results: CssFileRef[] = [];
	for (const [name, dirPath] of assetDirs) {
		collectCssFiles(name, dirPath, '', results);
	}
	return results;
}

function collectCssFiles(name: string, baseDir: string, rel: string, out: CssFileRef[]): void {
	const dir = rel ? path.join(baseDir, rel) : baseDir;
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const childRel = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			collectCssFiles(name, baseDir, childRel, out);
		} else if (entry.name.endsWith('.css')) {
			out.push({
				name,
				subpath: childRel,
				absolutePath: path.join(baseDir, childRel),
			});
		}
	}
}
