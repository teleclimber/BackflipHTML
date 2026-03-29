import * as fs from 'node:fs';
import * as path from 'node:path';

export type WatchCategory = 'template' | 'css' | 'config';

export type WatchCallback = (category: WatchCategory) => void;

export interface WatchOptions {
	/** Root directory containing templates (watched recursively for .html files). */
	templateRoot: string;
	/** Absolute path to a CSS file to watch. */
	cssPath?: string;
	/** Absolute path to backflip.json (or similar config file). */
	configPath?: string;
	/** Debounce interval in milliseconds (default 150). */
	debounceMs?: number;
}

export interface Watcher {
	close(): void;
}

/**
 * Watch template files, CSS, and config for changes.
 * Calls `callback` with the category of the change after debouncing.
 */
export function createWatcher(options: WatchOptions, callback: WatchCallback): Watcher {
	const debounceMs = options.debounceMs ?? 150;
	const watchers: fs.FSWatcher[] = [];
	const timers = new Map<WatchCategory, ReturnType<typeof setTimeout>>();

	function debounced(category: WatchCategory): void {
		const existing = timers.get(category);
		if (existing !== undefined) clearTimeout(existing);
		timers.set(category, setTimeout(() => {
			timers.delete(category);
			callback(category);
		}, debounceMs));
	}

	// Watch template directory recursively for .html files.
	try {
		const tw = fs.watch(options.templateRoot, { recursive: true }, (_event, filename) => {
			if (typeof filename === 'string' && filename.endsWith('.html')) {
				debounced('template');
			}
		});
		watchers.push(tw);
	} catch (err) {
		console.error('Failed to watch template directory:', err);
	}

	// Watch CSS file.
	if (options.cssPath) {
		try {
			const cw = fs.watch(options.cssPath, () => {
				debounced('css');
			});
			watchers.push(cw);
		} catch (err) {
			console.error('Failed to watch CSS file:', err);
		}
	}

	// Watch config file.
	if (options.configPath) {
		try {
			const cfgw = fs.watch(options.configPath, () => {
				debounced('config');
			});
			watchers.push(cfgw);
		} catch (err) {
			console.error('Failed to watch config file:', err);
		}
	}

	return {
		close() {
			for (const w of watchers) {
				try { w.close(); } catch { /* already closed */ }
			}
			watchers.length = 0;
			for (const t of timers.values()) clearTimeout(t);
			timers.clear();
		},
	};
}
