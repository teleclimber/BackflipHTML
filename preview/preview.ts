import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { CompiledFile } from '../compiler/types.js';
import { resolveDomPatchScriptUrl, type BackflipConfig } from '../compiler/config.js';
import { resolveAssetRefs } from '../compiler/helpers.js';
import { flattenCompiledFile } from '../compiler/flatten.js';
import { applyDomPatch } from '../compiler/generate/dom-patch/nodes2patch.js';
import { fileToJsModule } from '../compiler/generate/js/nodes2js.js';
import { renderRoot } from '../runtime/js/render.js';
import type { RootRNode } from '../runtime/js/render.js';
import { generateMockData } from './mock-data.js';
import { generateSlotPlaceholders } from './slot-placeholders.js';
import { wrapInChrome } from './preview-chrome.js';
import { inferDataShape } from '../compiler/data-shape.js';

export interface PreviewOptions {
	partialName: string;
	compiledFile: CompiledFile;
	allFiles?: Map<string, CompiledFile>;
	fileName?: string;
	cssHrefs?: string[];
	liveReload?: boolean;
	nonce?: string;
	dataOverrides?: Record<string, unknown>;
	tmpDir?: string;
	assetMap?: Map<string, string>;
	/** Absolute dirs the build would write dom-patch JS to (see resolveDomPatchOutputDirs). */
	domPatchOutputDirs?: string[];
	/** Dir to actually write the freshly generated dom-patch JS into. */
	domPatchOutDir?: string;
	/**
	 * Config used to derive each reactive partial's script URL for auto-include.
	 * Its asset prefixes should be the preview's serving prefixes (e.g.
	 * `/__assets/<name>/`) so injected URLs resolve against the preview server.
	 */
	config?: BackflipConfig;
	/** Directory the config paths are resolved against (the project dir). */
	configDir?: string;
}

export interface PreviewResult {
	html: string;
	mockData: Record<string, unknown>;
	errors: string[];
	/**
	 * Map of build destination path -> actual saved path for dom-patch JS generated
	 * this render. The key is where the file *would* live on a build (so an asset
	 * request resolving to that path can be matched); the value is the real file.
	 */
	domPatchAssets?: Record<string, string>;
}

/**
 * Preview a partial by compiling it, generating mock data, and rendering to HTML.
 */
export async function previewPartial(options: PreviewOptions): Promise<PreviewResult> {
	const { partialName, compiledFile, allFiles, fileName, cssHrefs, liveReload, nonce, dataOverrides, tmpDir, assetMap, domPatchOutputDirs, domPatchOutDir, config, configDir } = options;
	const errors: string[] = [];

	// Per-file script URL for dom-patch auto-include (null/undefined → not stamped).
	const scriptUrlFor = (relPath: string): string | undefined =>
		config && configDir !== undefined
			? (resolveDomPatchScriptUrl(configDir, config, relPath) ?? undefined)
			: undefined;

	// 1. Find the partial
	const root = compiledFile.partials.get(partialName);
	if (!root) {
		return { html: `<p>Partial "${partialName}" not found</p>`, mockData: {}, errors: [`Partial "${partialName}" not found`] };
	}

	// 2. Generate mock data from DataShape
	const shapes = inferDataShape(root);
	const lookup = { compiledFile, allFiles, fileName };
	const mockData = generateMockData(shapes, lookup, dataOverrides);

	// 3. Generate slot placeholders for the top-level partial's own slots
	const slotMap = generateSlotPlaceholders(root.tnodes);

	// 4. Compile to JS and evaluate to get RootRNode
	let rnode: RootRNode;
	try {
		rnode = await evalPartial(partialName, compiledFile, fileName ?? 'preview.html', allFiles, tmpDir, assetMap, scriptUrlFor);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		errors.push(`Eval error: ${msg}`);
		return { html: `<p>Error evaluating partial: ${escapeHtml(msg)}</p>`, mockData, errors };
	}

	// 5. Render
	let rendered: string;
	try {
		rendered = renderRoot(rnode, mockData, slotMap);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		errors.push(`Render error: ${msg}`);
		return { html: `<p>Error rendering partial: ${escapeHtml(msg)}</p>`, mockData, errors };
	}

	// 6. Wrap in chrome
	const html = wrapInChrome(rendered, partialName, { cssHrefs, fileName, liveReload, nonce });

	// 7. Capture dom-patch JS for the rendered file + its cross-file deps. evalPartial
	// already ran applyDomPatch on these cached ASTs, so regenerating here is idempotent
	// and the JS references the exact bfids present in the HTML above.
	let domPatchAssets: Record<string, string> | undefined;
	if (domPatchOutDir && domPatchOutputDirs && domPatchOutputDirs.length > 0) {
		const files = new Map(allFiles ?? []);
		files.set(fileName ?? 'preview.html', compiledFile);
		domPatchAssets = await writeDomPatchAssets(files, domPatchOutputDirs, domPatchOutDir, scriptUrlFor);
	}

	return { html, mockData, errors, domPatchAssets };
}

/**
 * Regenerate dom-patch JS for each file and save it under `outDir`. For every
 * configured dom-patch output dir, record where the build *would* write the file
 * (`<outputDir>/<file>.js`) mapped to the actual saved path, so an asset request
 * resolving to that build path can be served the fresh JS.
 */
async function writeDomPatchAssets(
	files: Map<string, CompiledFile>,
	outputDirs: string[],
	outDir: string,
	scriptUrlFor?: (relPath: string) => string | undefined,
): Promise<Record<string, string>> {
	const assets: Record<string, string> = {};
	for (const [relPath, file] of files) {
		const { js } = applyDomPatch(file, { scriptUrl: scriptUrlFor?.(relPath) });
		if (!js) continue;
		const jsRel = relPath.replace(/\.html$/, '.js');
		const savedPath = path.join(outDir, jsRel);
		await fs.mkdir(path.dirname(savedPath), { recursive: true });
		await fs.writeFile(savedPath, js, 'utf-8');
		for (const outputDir of outputDirs) {
			assets[path.join(outputDir, jsRel)] = savedPath;
		}
	}
	return assets;
}

/**
 * Evaluate compiled partials to get RootRNode objects.
 * Uses new Function() for same-file only, temp dir + import() for cross-file.
 */
async function evalPartial(
	partialName: string,
	compiledFile: CompiledFile,
	fileName: string,
	allFiles?: Map<string, CompiledFile>,
	tmpDir?: string,
	assetMap?: Map<string, string>,
	scriptUrlFor?: (relPath: string) => string | undefined,
): Promise<RootRNode> {
	// Mirror the CLI build: dom-patch mutates the AST in place (appending
	// data-bfid markers to reactive elements) and must run before flatten + js
	// codegen so the previewed HTML carries the ids the runtime queries on.
	applyDomPatch(compiledFile, { scriptUrl: scriptUrlFor?.(fileName) });
	const resolvedFile = assetMap ? resolveAssetRefs(compiledFile, assetMap) : compiledFile;
	const flattenedFile = flattenCompiledFile(resolvedFile);
	const js = fileToJsModule(flattenedFile, fileName, assetMap);
	const hasCrossFile = js.includes('import ');

	if (!hasCrossFile) {
		// Same-file: evaluate with new Function()
		const module = evalModule(js);
		const sanitized = sanitizeName(partialName);
		if (!(sanitized in module)) {
			throw new Error(`Partial "${partialName}" not found in generated JS`);
		}
		return module[sanitized] as RootRNode;
	}

	// Cross-file: write all files to temp dir and use dynamic import()
	if (!allFiles) {
		throw new Error('Cross-file partial references require allFiles to be provided');
	}

	const baseDir = tmpDir ?? getTmpDir();
	await fs.mkdir(baseDir, { recursive: true });
	const workDir = await fs.mkdtemp(path.join(baseDir, 'backflip-preview-'));
	try {
		// Write all compiled files as JS modules
		for (const [filePath, file] of allFiles) {
			const jsPath = path.join(workDir, filePath.replace('.html', '.js'));
			await fs.mkdir(path.dirname(jsPath), { recursive: true });
			applyDomPatch(file, { scriptUrl: scriptUrlFor?.(filePath) });
			const resolvedCrossFile = assetMap ? resolveAssetRefs(file, assetMap) : file;
			const flatCrossFile = flattenCompiledFile(resolvedCrossFile);
			await fs.writeFile(jsPath, fileToJsModule(flatCrossFile, filePath, assetMap), 'utf-8');
		}
		// Also write the current file if not already in allFiles
		if (!allFiles.has(fileName)) {
			const jsPath = path.join(workDir, fileName.replace('.html', '.js'));
			await fs.mkdir(path.dirname(jsPath), { recursive: true });
			await fs.writeFile(jsPath, js, 'utf-8');
		}

		// Import the file containing our partial
		const jsUrl = `file://${path.join(workDir, fileName.replace('.html', '.js'))}`;
		const mod = await import(jsUrl);
		const sanitized = sanitizeName(partialName);
		if (!(sanitized in mod)) {
			throw new Error(`Partial "${partialName}" not found in generated JS module`);
		}
		return mod[sanitized] as RootRNode;
	} finally {
		// Clean up temp dir
		await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
	}
}

function evalModule(js: string): Record<string, RootRNode> {
	const exportNames: string[] = [];
	const pattern = /^export const (\w+)/gm;
	let m;
	while ((m = pattern.exec(js)) !== null) exportNames.push(m[1]);
	const code = js.replace(/^export const /gm, 'const ');
	return new Function(code + `\nreturn { ${exportNames.join(', ')} };`)() as Record<string, RootRNode>;
}

function sanitizeName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_$]/g, '_');
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getTmpDir(): string {
	return process.env.TMPDIR ?? '/tmp';
}
