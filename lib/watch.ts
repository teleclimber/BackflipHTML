import * as fs from 'node:fs';
import * as path from 'node:path';

export type WatchCategory = 'template' | 'config' | 'asset';

export type WatchCallback = (category: WatchCategory) => void;

export interface WatchOptions {
	/** Root directory containing templates (watched recursively for .html files). */
	templateRoot: string;
	/** Absolute path to backflip.json (or similar config file). */
	configPath?: string;
	/** Absolute paths to asset directories to watch. */
	assetDirs?: string[];
	/** Debounce interval in milliseconds (default 150). */
	debounceMs?: number;
}

export interface Watcher {
	close(): void;
}

/** Walk up from `target` until an existing directory is found. */
function deepestExistingAncestor(target: string): string {
	let cur = target;
	while (!fs.existsSync(cur)) {
		const parent = path.dirname(cur);
		if (parent === cur) return cur; // reached the filesystem root
		cur = parent;
	}
	return cur;
}

interface TrackDirOptions {
	/** Category emitted when a (matching) file inside the directory changes. */
	contentCategory: WatchCategory;
	/** Category emitted when the directory itself appears or disappears. */
	existenceCategory: WatchCategory;
	/**
	 * Optional predicate restricting which content-change filenames count.
	 * When omitted, every change inside the directory counts.
	 */
	contentFilter?: (filename: string) => boolean;
}

/**
 * Watch a single configured directory that may or may not currently exist.
 *
 * Holds exactly one native watcher and re-targets it as the directory appears
 * and disappears:
 *
 *  - When the directory exists, it is watched recursively. Matching content
 *    changes emit `contentCategory`; if the directory vanishes (rename/delete)
 *    it emits `existenceCategory` and re-targets up to the nearest existing
 *    ancestor.
 *  - When the directory is missing, the nearest existing ancestor is watched
 *    non-recursively, and only events for the path segment leading to the
 *    directory are considered — so unrelated siblings never trigger anything.
 *    When the directory comes into existence it emits `existenceCategory` and
 *    re-targets onto it.
 *
 * Used both for the template root (content → `template`) and for each configured
 * asset directory (content → `asset`, existence → `config`, so that a config
 * reload re-validates directory existence and re-resolves the watched set).
 */
function trackDir(dir: string, debounced: (category: WatchCategory) => void, opts: TrackDirOptions): Watcher {
	let watcher: fs.FSWatcher | null = null;
	let watchedPath: string | null = null;
	let watchingDirItself = false;
	let closed = false;

	function closeWatcher(): void {
		if (watcher) {
			try { watcher.close(); } catch { /* already closed */ }
			watcher = null;
		}
	}

	function matchesContent(filename: string | null): boolean {
		if (!opts.contentFilter) return true;
		return typeof filename === 'string' && opts.contentFilter(filename);
	}

	function setup(): void {
		if (closed) return;
		closeWatcher();
		const exists = fs.existsSync(dir);
		const target = exists ? dir : deepestExistingAncestor(dir);
		watchingDirItself = exists;
		watchedPath = target;
		// The single path segment below `target` that leads to the tracked dir, used
		// to ignore unrelated entries while watching an ancestor non-recursively.
		const segment = exists ? null : (path.relative(target, dir).split(/[/\\]/)[0] || null);
		try {
			watcher = fs.watch(target, { recursive: exists }, (_event, filename) => onEvent(filename, segment));
		} catch (err) {
			console.error(`Failed to watch directory path ${target}:`, err);
			watcher = null;
		}
	}

	function onEvent(filename: string | null, segment: string | null): void {
		if (closed) return;

		if (watchingDirItself) {
			if (fs.existsSync(dir)) {
				if (matchesContent(filename)) debounced(opts.contentCategory);
			} else {
				// The directory was renamed/deleted; re-target up to an ancestor so
				// its re-creation can still be detected.
				debounced(opts.existenceCategory);
				setup();
			}
			return;
		}

		// Watching an ancestor because the directory is missing. Ignore events that
		// don't concern the segment leading to the directory. A null/empty filename
		// (e.g. the watched ancestor itself moved) always forces a re-evaluation.
		if (segment !== null && typeof filename === 'string' && filename.length > 0) {
			if (filename.split(/[/\\]/)[0] !== segment) return;
		}

		const nowExists = fs.existsSync(dir);
		const newTarget = nowExists ? dir : deepestExistingAncestor(dir);
		if (newTarget !== watchedPath) {
			if (nowExists) debounced(opts.existenceCategory); // directory appeared
			setup(); // move the watch down toward (or onto) the directory, or up if the ancestor vanished
		}
	}

	setup();

	return {
		close() {
			closed = true;
			closeWatcher();
		},
	};
}

/**
 * Watch template files, CSS, and config for changes.
 * Calls `callback` with the category of the change after debouncing.
 */
export function createWatcher(options: WatchOptions, callback: WatchCallback): Watcher {
	const debounceMs = options.debounceMs ?? 150;
	const watchers: Watcher[] = [];
	const timers = new Map<WatchCategory, ReturnType<typeof setTimeout>>();

	function debounced(category: WatchCategory): void {
		const existing = timers.get(category);
		if (existing !== undefined) clearTimeout(existing);
		timers.set(category, setTimeout(() => {
			timers.delete(category);
			callback(category);
		}, debounceMs));
	}

	// Watch the template directory for .html changes. A self-healing tracker so the
	// template root is picked up even if it is (re)created after the watcher starts.
	// Existence changes emit `config` (not `template`) so the config is reloaded and
	// re-validated, raising/clearing the root "directory not found" error — a plain
	// recompile would leave that diagnostic stale.
	watchers.push(trackDir(options.templateRoot, debounced, {
		contentCategory: 'template',
		existenceCategory: 'config',
		contentFilter: (filename) => filename.endsWith('.html'),
	}));

	// Watch each asset directory. Existence changes emit `config` so the config is
	// reloaded and re-validated (raising/clearing the "directory not found" error).
	if (options.assetDirs) {
		for (const assetDir of options.assetDirs) {
			watchers.push(trackDir(assetDir, debounced, {
				contentCategory: 'asset',
				existenceCategory: 'config',
			}));
		}
	}

	// Watch config file.
	if (options.configPath) {
		try {
			const cfgw = fs.watch(options.configPath, () => {
				debounced('config');
			});
			watchers.push({ close: () => { try { cfgw.close(); } catch { /* already closed */ } } });
		} catch (err) {
			console.error('Failed to watch config file:', err);
		}
	}

	return {
		close() {
			for (const w of watchers) w.close();
			watchers.length = 0;
			for (const t of timers.values()) clearTimeout(t);
			timers.clear();
		},
	};
}
