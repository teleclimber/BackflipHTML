import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);

/**
 * Recursively collect the files under `dir` whose name ends with `ext`, returning
 * paths relative to `base`.
 */
export async function collectFiles(dir: string, ext: string, base: string = dir): Promise<string[]> {
    let entries: Dirent<string>[];
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err: any) {
        // A missing directory (e.g. a template root that hasn't been created yet,
        // or a subdirectory removed mid-scan) contributes no files rather than
        // crashing the caller. Watch-based tools rely on this to start and then
        // pick the directory up once it appears.
        if (err?.code === 'ENOENT') return [];
        throw err;
    }
    const results: string[] = [];
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            results.push(...await collectFiles(fullPath, ext, base));
        } else if (entry.isFile() && entry.name.endsWith(ext)) {
            results.push(path.relative(base, fullPath));
        }
    }
    return results;
}
