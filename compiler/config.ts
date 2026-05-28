import * as path from 'node:path';
import * as fs from 'node:fs/promises';

export const CONFIG_FILENAME = 'backflip.json';

export interface AssetDirConfig {
	name: string;
	path: string;
	prefix: string;
}

export interface OutputConfig {
	lang: 'js' | 'php' | 'dom-patch';
	path: string;
}

export interface BackflipConfig {
	root: string;
	output?: OutputConfig[];
	assets?: AssetDirConfig[];
}

export interface LoadConfigResult {
	config: BackflipConfig | null;
	errors: string[];
}

export async function loadConfig(dir: string): Promise<LoadConfigResult> {
	const filePath = path.join(dir, CONFIG_FILENAME);
	let raw: string;
	try {
		raw = await fs.readFile(filePath, 'utf-8');
	} catch (err: any) {
		if (err.code === 'ENOENT') return { config: null, errors: [] };
		throw err;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`Invalid JSON in ${filePath}`);
	}

	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${CONFIG_FILENAME} must be a JSON object`);
	}

	const obj = parsed as Record<string, unknown>;

	if (typeof obj.root !== 'string') {
		throw new Error(`${CONFIG_FILENAME}: "root" is required and must be a string`);
	}

	const outputs: OutputConfig[] = [];
	if (obj.output !== undefined) {
		if (!Array.isArray(obj.output)) {
			throw new Error(`${CONFIG_FILENAME}: "output" must be an array of { lang, path } objects`);
		}
		const seenPaths = new Set<string>();
		for (let i = 0; i < obj.output.length; i++) {
			const entry = obj.output[i];
			if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
				throw new Error(`${CONFIG_FILENAME}: output[${i}] must be an object`);
			}
			const e = entry as Record<string, unknown>;
			if (e.lang !== 'js' && e.lang !== 'php' && e.lang !== 'dom-patch') {
				throw new Error(`${CONFIG_FILENAME}: output[${i}].lang must be "js", "php", or "dom-patch"`);
			}
			if (typeof e.path !== 'string') {
				throw new Error(`${CONFIG_FILENAME}: output[${i}].path must be a string`);
			}
			if (seenPaths.has(e.path)) {
				throw new Error(`${CONFIG_FILENAME}: duplicate output path "${e.path}"`);
			}
			seenPaths.add(e.path);
			outputs.push({ lang: e.lang as 'js' | 'php' | 'dom-patch', path: e.path });
		}
	}

	if ('lang' in obj) {
		throw new Error(`${CONFIG_FILENAME}: "lang" is no longer supported; specify "lang" inside each "output" entry`);
	}

	const configErrors: string[] = [];
	const validAssets: Record<string, unknown>[] = [];

	if (obj.assets !== undefined) {
		if (!Array.isArray(obj.assets)) {
			throw new Error(`${CONFIG_FILENAME}: "assets" must be an array`);
		}
		const nameRe = /^[a-zA-Z0-9_-]+$/;
		const seenNames = new Set<string>();
		for (let i = 0; i < obj.assets.length; i++) {
			const entry = obj.assets[i];
			if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
				throw new Error(`${CONFIG_FILENAME}: assets[${i}] must be an object`);
			}
			const e = entry as Record<string, unknown>;
			if (typeof e.name !== 'string' || !nameRe.test(e.name)) {
				throw new Error(`${CONFIG_FILENAME}: assets[${i}].name must be alphanumeric with dashes and underscores only`);
			}
			if (seenNames.has(e.name)) {
				throw new Error(`${CONFIG_FILENAME}: duplicate asset name "${e.name}"`);
			}
			seenNames.add(e.name);
			if (typeof e.path !== 'string') {
				throw new Error(`${CONFIG_FILENAME}: assets[${i}].path must be a string`);
			}
			const resolvedPath = path.resolve(dir, e.path);
			const resolvedDir = path.resolve(dir);
			if (!resolvedPath.startsWith(resolvedDir + path.sep) && resolvedPath !== resolvedDir) {
				throw new Error(`${CONFIG_FILENAME}: assets[${i}].path must not escape the project directory`);
			}
			if (typeof e.prefix !== 'string') {
				throw new Error(`${CONFIG_FILENAME}: assets[${i}].prefix must be a string`);
			}
			if (!e.prefix.endsWith('/')) {
				throw new Error(`${CONFIG_FILENAME}: assets[${i}].prefix must end with "/"`);
			}
			// Path existence checks are soft errors: record error but keep the asset
			try {
				const stat = await fs.stat(resolvedPath);
				if (!stat.isDirectory()) {
					configErrors.push(`${CONFIG_FILENAME}: assets[${i}].path is not a directory: ${e.path}`);
				}
			} catch (err: any) {
				if (err.code === 'ENOENT') {
					configErrors.push(`${CONFIG_FILENAME}: assets[${i}].path directory not found: ${e.path}`);
				} else {
					throw err;
				}
			}
			validAssets.push(e);
		}
	}

	const config: BackflipConfig = { root: obj.root };
	if (outputs.length > 0) config.output = outputs;
	if (validAssets.length > 0) {
		config.assets = validAssets.map(e => ({
			name: e.name as string,
			path: e.path as string,
			prefix: e.prefix as string,
		}));
	}

	return { config, errors: configErrors };
}

export function resolveConfigRoot(configDir: string, config: BackflipConfig): string {
	return path.resolve(configDir, config.root);
}

export function resolveAssetDirs(configDir: string, config: BackflipConfig): Map<string, string> {
	const result = new Map<string, string>();
	if (config.assets) {
		for (const asset of config.assets) {
			result.set(asset.name, path.resolve(configDir, asset.path));
		}
	}
	return result;
}

/**
 * Absolute directories that `dom-patch` output is written to. The preview uses
 * these to compute where each generated JS file *would* be saved on a build, so
 * it can serve freshly generated JS (whose bfids match the previewed HTML) for
 * any asset request that resolves to such a path — regardless of whether the
 * dom-patch dir equals an asset dir or sits inside one.
 */
export function resolveDomPatchOutputDirs(configDir: string, config: BackflipConfig): string[] {
	return (config.output ?? [])
		.filter(o => o.lang === 'dom-patch')
		.map(o => path.resolve(configDir, o.path));
}
