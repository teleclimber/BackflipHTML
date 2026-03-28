import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { collectSlots } from '../compiler/compiler.js';
import type { CompiledFile } from '../compiler/compiler.js';
import { fileToJsModule } from '../compiler/generate/js/nodes2js.js';
import { renderRoot } from '../runtime/js/render.js';
import type { RootRNode } from '../runtime/js/render.js';
import { generateMockData } from './mock-data.js';
import { generateSlotPlaceholders } from './slot-placeholders.js';
import { wrapInChrome } from './preview-chrome.js';

export interface PreviewOptions {
	partialName: string;
	compiledFile: CompiledFile;
	allFiles?: Map<string, CompiledFile>;
	fileName?: string;
	cssContent?: string;
	dataOverrides?: Record<string, unknown>;
	tmpDir?: string;
}

export interface PreviewResult {
	html: string;
	mockData: Record<string, unknown>;
	errors: string[];
}

/**
 * Preview a partial by compiling it, generating mock data, and rendering to HTML.
 */
export async function previewPartial(options: PreviewOptions): Promise<PreviewResult> {
	const { partialName, compiledFile, allFiles, fileName, cssContent, dataOverrides, tmpDir } = options;
	const errors: string[] = [];

	// 1. Find the partial
	const root = compiledFile.partials.get(partialName);
	if (!root) {
		return { html: `<p>Partial "${partialName}" not found</p>`, mockData: {}, errors: [`Partial "${partialName}" not found`] };
	}

	// 2. Generate mock data from DataShape
	const shapes = root.dataShape ?? new Map();
	const lookup = { compiledFile, allFiles, fileName };
	const mockData = generateMockData(shapes, lookup, dataOverrides);

	// 3. Generate slot placeholders for the top-level partial's own slots
	const slotNames = collectSlots(root.tnodes);
	const slotMap = generateSlotPlaceholders(slotNames);

	// 4. Compile to JS and evaluate to get RootRNode
	let rnode: RootRNode;
	try {
		rnode = await evalPartial(partialName, compiledFile, fileName ?? 'preview.html', allFiles, tmpDir);
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
	const isDocumentLevel = root.meta?.isDocumentLevel ?? false;
	const html = wrapInChrome(rendered, partialName, { cssContent, isDocumentLevel });

	return { html, mockData, errors };
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
): Promise<RootRNode> {
	const js = fileToJsModule(compiledFile, fileName);
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
			await fs.writeFile(jsPath, fileToJsModule(file, filePath), 'utf-8');
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
