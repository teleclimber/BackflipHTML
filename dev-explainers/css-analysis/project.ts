import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackflipConfig, CompileOptions } from '@backflip/html';
import { CONFIG_FILENAME, compileFiles, loadConfig, resolveAssetDirs, resolveConfigRoot } from '@backflip/html';
import { discoverCssFiles } from '../../css/src/discover.js';
import { collectExplain, type ExplainInput, type ExplainPayload } from './collect.js';

/**
 * Turning the arguments into a compiled project: which templates and
 * stylesheets to read, and — the part that is easy to forget — the asset
 * configuration to compile them under.
 *
 * Separate from `cli.ts` because that file runs `main()` on import; this half
 * has to be reachable from a test.
 */

/** The demo project that ships beside this tool, used by `--demo`. */
export const DEMO = path.join(import.meta.dirname!, 'demo');

/** The arguments that decide what gets analysed. `Args` in cli.ts is a superset. */
export interface ProjectArgs {
	demo: boolean;
	project?: string;
	templates?: string;
	css: string[];
}

export interface ResolvedInput {
	templateDir: string;
	cssPaths: string[];
	/** Asset configuration, when the project configures any. */
	compileOptions?: CompileOptions;
	/** Directory the backflip.json came from; absent when no config was used. */
	configDir?: string;
}

/** Every .html file under `dir`, keyed by its path relative to `dir`. */
export function readTemplates(dir: string): Map<string, string> {
	const files = new Map<string, string>();
	const walk = (current: string, prefix: string): void => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
			else if (entry.name.endsWith('.html')) files.set(prefix + entry.name, fs.readFileSync(full, 'utf-8'));
		}
	};
	walk(dir, '');
	return files;
}

/**
 * The nearest directory at or above `from` holding a backflip.json, or null.
 * `--templates` points at a directory inside a project rather than at the
 * project, so walking up finds the config that governs it — a hand-pointed run
 * then compiles under the same asset configuration as a build would.
 */
export function findConfigDir(from: string): string | null {
	let dir = path.resolve(from);
	for (;;) {
		if (fs.existsSync(path.join(dir, CONFIG_FILENAME))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * Compile options for a project, matching what a real build of it would use.
 *
 * The asset map has to be here. Without one the compiler drops every `src~`,
 * `href~` and `srcset~` attribute it meets and reports each as a diagnostic, so
 * an analysis run missing it does two kinds of damage: it buries the page in
 * diagnostics, and it matches selectors against elements that have quietly lost
 * their attributes. Prefixes are the config's own — not the preview server's
 * `/__assets/` — because this explains the project as it builds.
 */
export function assetOptions(configDir: string, config: BackflipConfig): CompileOptions | undefined {
	if (!config.assets || config.assets.length === 0) return undefined;
	return {
		assetMap: new Map(config.assets.map(a => [a.name, a.prefix])),
		assetDirs: resolveAssetDirs(configDir, config),
	};
}

export async function resolveInput(args: ProjectArgs): Promise<ResolvedInput> {
	if (args.demo && !args.templates && !args.project) {
		const configDir = fs.existsSync(path.join(DEMO, CONFIG_FILENAME)) ? DEMO : null;
		const config = configDir === null ? null : (await loadConfig(configDir)).config;
		return {
			templateDir: path.join(DEMO, 'templates'),
			cssPaths: args.css.length > 0 ? args.css : [path.join(DEMO, 'styles.css')],
			compileOptions: config ? assetOptions(DEMO, config) : undefined,
			configDir: config ? DEMO : undefined,
		};
	}
	if (args.templates) {
		if (args.css.length === 0) throw new Error('--templates needs at least one --css');
		// A hand-pointed template directory still belongs to a project. Find the
		// config governing it, for the assets; a missing one is not an error
		// here, since --templates deliberately bypasses config resolution.
		const configDir = findConfigDir(args.templates);
		const config = configDir === null ? null : (await loadConfig(configDir)).config;
		if (configDir === null || !config) return { templateDir: args.templates, cssPaths: args.css };
		return {
			templateDir: args.templates,
			cssPaths: args.css,
			compileOptions: assetOptions(configDir, config),
			configDir,
		};
	}
	const root = path.resolve(args.project!);
	const { config, errors } = await loadConfig(root);
	if (!config) {
		throw new Error(`no ${CONFIG_FILENAME} in ${root}${errors.length ? ` (${errors.join('; ')})` : ''}`);
	}
	const templateDir = resolveConfigRoot(root, config);
	const cssPaths = args.css.length > 0
		? args.css
		: discoverCssFiles(resolveAssetDirs(root, config)).map(ref => ref.absolutePath);
	if (cssPaths.length === 0) throw new Error(`no .css files found in the asset dirs of ${root}`);
	return { templateDir, cssPaths, compileOptions: assetOptions(root, config), configDir: root };
}

/**
 * Read the project off disk and run the analyzer over it. Called once for a
 * one-shot run, and once per request when serving — everything it touches is
 * read fresh, so a reload reflects the files as they are now.
 */
export async function buildPayload(args: ProjectArgs): Promise<ExplainPayload> {
	const { templateDir, cssPaths, compileOptions, configDir } = await resolveInput(args);
	const sources = readTemplates(templateDir);
	if (sources.size === 0) throw new Error(`no .html templates under ${templateDir}`);

	// Compile errors are reported, not fatal: analysing a half-broken project is
	// exactly when this tool is useful.
	const { directory, errors } = await compileFiles(sources, compileOptions);

	const input: ExplainInput = {
		project: args.demo ? 'css-analysis/demo (bundled)' : path.relative(process.cwd(), templateDir) || templateDir,
		compiled: directory.files,
		sources,
		cssContent: cssPaths.map(p => fs.readFileSync(p, 'utf-8')).join('\n'),
		cssFiles: cssPaths.map(p => path.basename(p)),
		assetDirs: [...(compileOptions?.assetMap?.keys() ?? [])],
		configDir: configDir === undefined ? undefined : path.relative(process.cwd(), configDir) || '.',
		warnings: errors.map(e => e.message),
	};
	return collectExplain(input);
}
