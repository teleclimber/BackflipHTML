export interface AssetFileRef {
	/** Asset directory name (from config). */
	name: string;
	/** Relative path within the asset directory. */
	subpath: string;
	/** Absolute path on disk. */
	absolutePath: string;
}

export interface AssetFileInfo {
	/** Asset directory name (from config). */
	name: string;
	/** Relative path within the asset directory. */
	subpath: string;
	/** Absolute path on disk. */
	absolutePath: string;
	/** File extension (lowercase, with dot). */
	ext: string;
	/** File size in bytes. */
	size: number;
	/** Whether this is an image file. */
	isImage: boolean;
}

export interface AssetReference {
	/** Source file path relative to its root (template or asset dir). */
	sourceFile: string;
	/** Partial that contains the reference (for templates only). */
	partialName?: string;
	/** 1-based line number. */
	line: number;
	/** 1-based column number. */
	column: number;
	/** The @name part of the asset reference. */
	assetName: string;
	/** The subpath part of the asset reference. */
	assetSubpath: string;
}

export interface AssetUsageEntry {
	asset: AssetFileInfo;
	references: AssetReference[];
	isUsed: boolean;
}

export interface AssetUsageReport {
	generatedAt: string;
	entries: AssetUsageEntry[];
	summary: {
		totalAssets: number;
		usedAssets: number;
		unusedAssets: number;
		totalReferences: number;
	};
}
