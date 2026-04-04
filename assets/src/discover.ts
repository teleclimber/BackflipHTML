import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AssetFileRef, AssetFileInfo } from './types.js';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.avif', '.ico']);

/**
 * Scan configured asset directories for files.
 * When no filter is provided, returns all files.
 * Pass a filter to restrict results (e.g. `f => f.endsWith('.css')`).
 */
export function discoverAssetFiles(
	assetDirs: Map<string, string>,
	filter?: (filename: string) => boolean,
): AssetFileRef[] {
	const results: AssetFileRef[] = [];
	for (const [name, dirPath] of assetDirs) {
		collectFiles(name, dirPath, '', filter, results);
	}
	return results;
}

/**
 * Discover asset files and enrich with file metadata.
 */
export function discoverAssetFileInfos(
	assetDirs: Map<string, string>,
): AssetFileInfo[] {
	const refs = discoverAssetFiles(assetDirs);
	return refs.map(ref => {
		const ext = path.extname(ref.subpath).toLowerCase();
		let size = 0;
		try {
			size = fs.statSync(ref.absolutePath).size;
		} catch {
			// file may have been deleted since discovery
		}
		return {
			name: ref.name,
			subpath: ref.subpath,
			absolutePath: ref.absolutePath,
			ext,
			size,
			isImage: IMAGE_EXTENSIONS.has(ext),
		};
	});
}

function collectFiles(
	name: string,
	baseDir: string,
	rel: string,
	filter: ((filename: string) => boolean) | undefined,
	out: AssetFileRef[],
): void {
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
			collectFiles(name, baseDir, childRel, filter, out);
		} else if (!filter || filter(entry.name)) {
			out.push({
				name,
				subpath: childRel,
				absolutePath: path.join(baseDir, childRel),
			});
		}
	}
}
