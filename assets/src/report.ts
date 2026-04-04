import type { AssetFileInfo, AssetReference, AssetUsageEntry, AssetUsageReport } from './types.js';

/** Common OS files that should be ignored if they are unused. */
const UNUSED_OS_FILES = new Set(['Thumbs.db', '.DS_Store']);

/**
 * Cross-reference discovered asset files with template references
 * to produce a usage report.
 */
export function buildAssetUsageReport(
	assets: AssetFileInfo[],
	refs: AssetReference[],
): AssetUsageReport {
	// Index references by "@name/subpath"
	const refsByKey = new Map<string, AssetReference[]>();
	for (const ref of refs) {
		const key = `${ref.assetName}/${ref.assetSubpath}`;
		let list = refsByKey.get(key);
		if (!list) {
			list = [];
			refsByKey.set(key, list);
		}
		list.push(ref);
	}

	const entries: AssetUsageEntry[] = [];
	let usedCount = 0;

	for (const asset of assets) {
		const key = `${asset.name}/${asset.subpath}`;
		const assetRefs = refsByKey.get(key) ?? [];
		const isUsed = assetRefs.length > 0;

		// Skip unused common OS files
		if (!isUsed) {
			const basename = asset.subpath.split('/').pop() || asset.subpath;
			if (UNUSED_OS_FILES.has(basename)) {
				continue;
			}
		}

		if (isUsed) usedCount++;
		entries.push({ asset, references: assetRefs, isUsed });
	}

	return {
		generatedAt: new Date().toISOString(),
		entries,
		summary: {
			totalAssets: entries.length,
			usedAssets: usedCount,
			unusedAssets: entries.length - usedCount,
			totalReferences: refs.length,
		},
	};
}

/**
 * Filter a report to only include entries matching given criteria.
 */
export function filterReport(
	report: AssetUsageReport,
	filter: { name?: string; subpath?: string; subpathPrefix?: string; unusedOnly?: boolean },
): AssetUsageReport {
	let entries = report.entries;
	if (filter.name) {
		entries = entries.filter(e => e.asset.name === filter.name);
	}
	if (filter.subpath) {
		entries = entries.filter(e => e.asset.subpath === filter.subpath);
	}
	if (filter.subpathPrefix) {
		const prefix = filter.subpathPrefix;
		entries = entries.filter(e => e.asset.subpath.startsWith(prefix));
	}
	if (filter.unusedOnly) {
		entries = entries.filter(e => !e.isUsed);
	}
	const usedCount = entries.filter(e => e.isUsed).length;
	const totalRefs = entries.reduce((sum, e) => sum + e.references.length, 0);
	return {
		generatedAt: report.generatedAt,
		entries,
		summary: {
			totalAssets: entries.length,
			usedAssets: usedCount,
			unusedAssets: entries.length - usedCount,
			totalReferences: totalRefs,
		},
	};
}
