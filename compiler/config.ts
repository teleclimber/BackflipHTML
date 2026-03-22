import * as path from 'node:path';
import * as fs from 'node:fs/promises';

export const CONFIG_FILENAME = 'backflip.json';

export interface BackflipConfig {
	root: string;
	output?: string;
	lang?: 'js' | 'php';
}

export async function loadConfig(dir: string): Promise<BackflipConfig | null> {
	const filePath = path.join(dir, CONFIG_FILENAME);
	let raw: string;
	try {
		raw = await fs.readFile(filePath, 'utf-8');
	} catch (err: any) {
		if (err.code === 'ENOENT') return null;
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

	if (obj.output !== undefined && typeof obj.output !== 'string') {
		throw new Error(`${CONFIG_FILENAME}: "output" must be a string`);
	}

	if (obj.lang !== undefined && obj.lang !== 'js' && obj.lang !== 'php') {
		throw new Error(`${CONFIG_FILENAME}: "lang" must be "js" or "php"`);
	}

	const config: BackflipConfig = { root: obj.root };
	if (obj.output !== undefined) config.output = obj.output as string;
	if (obj.lang !== undefined) config.lang = obj.lang as 'js' | 'php';

	return config;
}

export function resolveConfigRoot(configDir: string, config: BackflipConfig): string {
	return path.resolve(configDir, config.root);
}
