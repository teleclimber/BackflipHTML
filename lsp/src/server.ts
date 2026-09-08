import {
	createConnection,
	TextDocuments,
	ProposedFeatures,
	InitializeParams,
	InitializeResult,
	TextDocumentSyncKind,
	DefinitionParams,
	ReferenceParams,
	DocumentSymbolParams,
	HoverParams,
	CompletionParams,
	CompletionItem,
	CompletionItemKind,
	DiagnosticSeverity,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { compileDirectory, loadConfig, resolveConfigRoot, resolveAssetDirs, resolveDomPatchOutputDirs, CONFIG_FILENAME, previewPartial, parseBPartValue, type BackflipError, type CompiledFile, type CompileOptions, type LoadConfigResult } from '@backflip/html';
import { analyzeCss, discoverCssFiles, type CssAnalysisResult, type CssSourceFile } from '@backflip/css';
import { discoverAssetFileInfos, collectAllAssetReferences, validateAssetFiles, buildAssetUsageReport, filterReport, renderAssetReportHtml } from '@backflip/assets';
import { buildIndex, type ProjectIndex } from './index.js';
import { errorsToDiagnostics, cssFailuresToDiagnostics } from './diagnostics.js';
import { findDefinition, findAssetDefinition, findCustomElementDefinition } from './definition.js';
import { findReferences, parseAssetRefAtCursor, findAssetReferences } from './references.js';
import { getDocumentSymbols } from './symbols.js';
import { getHover, findElementsForSelector, findRulesForElement, findCustomElementTagAtCursor } from './hover.js';
import { createWatcher, type Watcher, type WatchOptions, type WatchCallback } from '../../lib/watch.js';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let workspaceRoot = '';
let templateRoot: string | null = null;
let cssPaths: string[] = [];
let projectIndex: ProjectIndex = { partialDefs: new Map(), partialRefs: [] };
let compiledFiles: Map<string, CompiledFile> = new Map();
let cssAnalysis: CssAnalysisResult | null = null;
let recompileTimer: ReturnType<typeof setTimeout> | null = null;
let knownFiles: Set<string> = new Set();
/** Stylesheets we published diagnostics for, so they can be cleared. */
let knownCssFiles: Set<string> = new Set();
let assetMap: Map<string, string> | undefined;
let assetDirs: Map<string, string> | undefined;
let templateFileContents: Map<string, string> = new Map();
let domPatchOutputDirs: string[] = [];
let domPatchTmpDir: string | undefined;
let fileWatcher: Watcher | null = null;

connection.onInitialize((params: InitializeParams): InitializeResult => {
	workspaceRoot = params.workspaceFolders?.[0]?.uri?.replace('file://', '') ?? '';
	connection.console.log(`[backflip] initialize: workspaceRoot=${workspaceRoot}`);

	return {
		capabilities: {
			textDocumentSync: {
				openClose: true,
				change: TextDocumentSyncKind.Full,
				save: true,
			},
			definitionProvider: true,
			referencesProvider: true,
			documentSymbolProvider: true,
			hoverProvider: true,
			completionProvider: {
				triggerCharacters: ['@', '/'],
			},
		},
	};
});

connection.onInitialized(async () => {
	if (workspaceRoot) {
		await loadAndApplyConfig();
	}
});

let configErrors: string[] = [];

async function loadAndApplyConfig(): Promise<void> {
	try {
		const result = await loadConfig(workspaceRoot);
		configErrors = result.errors;
		const config = result.config;
		if (!config) {
			connection.console.log(`[backflip] no ${CONFIG_FILENAME} found in ${workspaceRoot}, staying inactive`);
			templateRoot = null;
			cssPaths = [];
			cssAnalysis = null;
			compiledFiles = new Map();
			assetMap = undefined;
			assetDirs = undefined;
			domPatchOutputDirs = [];
			clearAllDiagnostics();
			projectIndex = { partialDefs: new Map(), partialRefs: [] };
			return;
		}
		templateRoot = resolveConfigRoot(workspaceRoot, config);
		domPatchOutputDirs = resolveDomPatchOutputDirs(workspaceRoot, config);
		if (config.assets && config.assets.length > 0) {
			assetMap = new Map(config.assets.map(a => [a.name, `/__assets/${a.name}/`]));
			assetDirs = resolveAssetDirs(workspaceRoot, config);
			cssPaths = discoverCssFiles(assetDirs).map(ref => ref.absolutePath);
		} else {
			assetMap = undefined;
			assetDirs = undefined;
			cssPaths = [];
		}
		connection.console.log(`[backflip] config loaded, template root: ${templateRoot}${cssPaths.length > 0 ? `, css files: ${cssPaths.length}` : ''}${assetMap ? `, assets: ${assetMap.size}` : ''}${configErrors.length > 0 ? `, config errors: ${configErrors.length}` : ''}`);
		await recompile();
	} catch (err) {
		connection.console.error(`[backflip] config error: ${err instanceof Error ? err.message : err}`);
		templateRoot = null;
		cssPaths = [];
		cssAnalysis = null;
		compiledFiles = new Map();
		assetMap = undefined;
		assetDirs = undefined;
		domPatchOutputDirs = [];
		configErrors = [];
		clearAllDiagnostics();
		projectIndex = { partialDefs: new Map(), partialRefs: [] };
	} finally {
		setupFileWatcher();
	}
}

/**
 * (Re)create the native filesystem watcher. Runs after every config load so the
 * watched template root and asset dirs track the current config. Unlike VS Code's
 * suffix-glob watchers, the native recursive watcher surfaces per-file events for
 * directory renames/moves, so those trigger a recompile too.
 */
function setupFileWatcher(): void {
	if (fileWatcher) {
		fileWatcher.close();
		fileWatcher = null;
	}
	if (!workspaceRoot) return;

	const options: WatchOptions = {
		// Fall back to the workspace root when there's no config yet, so newly
		// added templates are still noticed.
		templateRoot: templateRoot ?? workspaceRoot,
		configPath: path.join(workspaceRoot, CONFIG_FILENAME),
	};
	if (assetDirs && assetDirs.size > 0) {
		options.assetDirs = Array.from(assetDirs.values());
	}

	const onWatch: WatchCallback = (category) => {
		if (category === 'config') {
			// Config may have changed the watched dirs; loadAndApplyConfig
			// recreates the watcher via its finally block.
			loadAndApplyConfig();
		} else {
			scheduleRecompile();
		}
	};

	fileWatcher = createWatcher(options, onWatch);
}

function clearAllDiagnostics(): void {
	for (const filePath of knownFiles) {
		const uri = `file://${templateRoot ?? workspaceRoot}/${filePath}`;
		connection.sendDiagnostics({ uri, diagnostics: [] });
	}
	knownFiles = new Set();

	for (const cssPath of knownCssFiles) {
		connection.sendDiagnostics({ uri: `file://${cssPath}`, diagnostics: [] });
	}
	knownCssFiles = new Set();
}

async function recompile(): Promise<void> {
	if (!templateRoot) return;

	// Re-discover CSS files in case assets changed
	if (assetDirs) {
		cssPaths = discoverCssFiles(assetDirs).map(ref => ref.absolutePath);
	}

	try {
		const compileOpts: CompileOptions = { includeLocs: true };
		if (assetMap) compileOpts.assetMap = assetMap;
		if (assetDirs) compileOpts.assetDirs = assetDirs;
		const { directory, errors } = await compileDirectory(templateRoot, compileOpts);
		compiledFiles = directory.files;

		if (assetDirs) {
			const refs = collectAllAssetReferences(directory.files, assetDirs);
			const assetErrors = validateAssetFiles(refs, assetDirs);
			errors.push(...assetErrors);
		}

		projectIndex = buildIndex(directory);
		connection.console.log(`[backflip] recompile: ${directory.files.size} files, ${errors.length} errors, ${projectIndex.partialDefs.size} partials, ${projectIndex.partialRefs.length} refs`);

		// Read template file contents (used for asset reference lookups)
		templateFileContents = new Map();
		for (const [filePath] of directory.files) {
			try {
				const fullPath = path.join(templateRoot, filePath);
				const html = await fs.readFile(fullPath, 'utf-8');
				templateFileContents.set(filePath, html);
			} catch {
				// skip unreadable files
			}
		}

		// Run CSS analysis if CSS files are discovered in asset dirs
		cssAnalysis = null;
		if (cssPaths.length > 0 && templateRoot) {
			try {
				const cssFiles: CssSourceFile[] = [];
				for (const cssPath of cssPaths) {
					cssFiles.push({ path: cssPath, content: await fs.readFile(cssPath, 'utf-8') });
				}
				const cssStart = performance.now();
				cssAnalysis = analyzeCss({ files: cssFiles, compiled: directory.files });
				const cssElapsed = performance.now() - cssStart;
				const matchCount = Array.from(cssAnalysis.elementMatches.values())
					.reduce((sum, arr) => sum + arr.length, 0);
				const failureNote = cssAnalysis.failures.length > 0 ? `, ${cssAnalysis.failures.length} unparsed region(s)` : '';
				connection.console.log(`[backflip] css analysis: ${cssPaths.length} file(s), ${cssAnalysis.rules.length} rules, ${matchCount} element matches${failureNote} (${cssElapsed.toFixed(0)}ms)`);
			} catch (err) {
				connection.console.error(`[backflip] css analysis failed: ${err instanceof Error ? err.message : err}`);
			}
		}

		// Publish diagnostics
		const diagsByFile = errorsToDiagnostics(errors as BackflipError[]);

		// Clear diagnostics for files no longer present
		for (const filePath of knownFiles) {
			if (!directory.files.has(filePath)) {
				const uri = `file://${templateRoot}/${filePath}`;
				connection.sendDiagnostics({ uri, diagnostics: [] });
			}
		}

		// Track known files and publish diagnostics
		knownFiles = new Set();
		for (const [filePath] of directory.files) {
			knownFiles.add(filePath);
			const uri = `file://${templateRoot}/${filePath}`;
			connection.sendDiagnostics({
				uri,
				diagnostics: diagsByFile.get(filePath) ?? [],
			});
		}

		// CSS parse warnings, published against the stylesheets themselves. These
		// live outside templateRoot (asset dirs), so their absolute path is the
		// URI directly. Every discovered stylesheet is published every pass,
		// empty included, so a fixed warning clears.
		const cssDiags = cssFailuresToDiagnostics(cssAnalysis?.failures ?? []);
		for (const cssPath of knownCssFiles) {
			if (!cssPaths.includes(cssPath)) {
				connection.sendDiagnostics({ uri: `file://${cssPath}`, diagnostics: [] });
			}
		}
		knownCssFiles = new Set(cssPaths);
		for (const cssPath of cssPaths) {
			connection.sendDiagnostics({
				uri: `file://${cssPath}`,
				diagnostics: cssDiags.get(cssPath) ?? [],
			});
		}

		// Also publish diagnostics for files without a specific file path
		const globalDiags = diagsByFile.get('');
		if (globalDiags && globalDiags.length > 0) {
			connection.sendDiagnostics({
				uri: `file://${templateRoot}`,
				diagnostics: globalDiags,
			});
		}

		// Publish config errors as diagnostics on backflip.json
		const configUri = `file://${path.join(workspaceRoot, CONFIG_FILENAME)}`;
		if (configErrors.length > 0) {
			connection.sendDiagnostics({
				uri: configUri,
				diagnostics: configErrors.map(msg => ({
					severity: DiagnosticSeverity.Error,
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
					message: msg,
					source: 'backflip',
				})),
			});
		} else {
			connection.sendDiagnostics({ uri: configUri, diagnostics: [] });
		}
		connection.sendNotification('backflip/analysisUpdated');
	} catch (err) {
		connection.console.error(`[backflip] recompile failed: ${err instanceof Error ? err.stack : err}`);
	}
}

function scheduleRecompile(): void {
	if (recompileTimer) {
		clearTimeout(recompileTimer);
	}
	recompileTimer = setTimeout(() => {
		recompileTimer = null;
		recompile();
	}, 300);
}

documents.listen(connection);

// Recompile on save (or reload config if backflip.json changed)
documents.onDidSave((event) => {
	const filePath = event.document.uri.replace('file://', '');
	const fileName = path.basename(filePath);

	if (fileName === CONFIG_FILENAME) {
		loadAndApplyConfig();
	} else {
		scheduleRecompile();
	}
});

// Go to Definition: b-part → b-name
connection.onDefinition((params: DefinitionParams) => {
	if (!templateRoot) return null;

	const uri = params.textDocument.uri;
	const doc = documents.get(uri);
	if (!doc) return null;

	const line = doc.getText({
		start: { line: params.position.line, character: 0 },
		end: { line: params.position.line + 1, character: 0 },
	});

	// Check if cursor is on an asset reference
	if (assetDirs) {
		const assetDef = findAssetDefinition(line, params.position.character, assetDirs);
		if (assetDef) return assetDef;
	}

	// Check if cursor is on a custom element partial tag
	const ceTag = findCustomElementTagAtCursor(line, params.position.character);
	if (ceTag) {
		const ceDef = findCustomElementDefinition(ceTag.tagName, projectIndex, templateRoot);
		if (ceDef) return ceDef;
	}

	// Check if cursor is on a b-part attribute value
	const bPartMatch = line.match(/b-part="([^"]*)"/);
	if (!bPartMatch) return null;

	const attrStart = line.indexOf(bPartMatch[0]);
	const valueStart = attrStart + 'b-part="'.length;
	const valueEnd = valueStart + bPartMatch[1].length;

	// Check cursor is within the attribute value
	if (params.position.character < valueStart || params.position.character > valueEnd) {
		return null;
	}

	const value = bPartMatch[1];
	const filePath = uri.replace('file://', '');
	const relPath = path.relative(templateRoot, filePath);

	const { partialName, file } = parseBPartValue(value);

	return findDefinition(partialName, file, relPath, projectIndex, templateRoot);
});

// Find References: b-name → all b-part usages
connection.onReferences((params: ReferenceParams) => {
	if (!templateRoot) return null;

	const uri = params.textDocument.uri;
	const doc = documents.get(uri);
	if (!doc) return null;

	const line = doc.getText({
		start: { line: params.position.line, character: 0 },
		end: { line: params.position.line + 1, character: 0 },
	});

	// Check if cursor is on an asset reference
	if (assetDirs && templateFileContents.size > 0) {
		const assetRef = parseAssetRefAtCursor(line, params.position.character);
		if (assetRef) {
			return findAssetReferences(assetRef.name, assetRef.subpath, templateFileContents, templateRoot);
		}
	}

	// Check if cursor is on a b-name attribute value
	const bNameMatch = line.match(/b-name="([^"]*)"/);
	if (!bNameMatch) return null;

	const attrStart = line.indexOf(bNameMatch[0]);
	const valueStart = attrStart + 'b-name="'.length;
	const valueEnd = valueStart + bNameMatch[1].length;

	if (params.position.character < valueStart || params.position.character > valueEnd) {
		return null;
	}

	const partialName = bNameMatch[1];
	const filePath = uri.replace('file://', '');
	const relPath = path.relative(templateRoot, filePath);

	return findReferences(partialName, relPath, projectIndex, templateRoot);
});

// Document Symbols: list partials in file
connection.onDocumentSymbol((params: DocumentSymbolParams) => {
	if (!templateRoot) return null;

	const uri = params.textDocument.uri;
	const filePath = uri.replace('file://', '');
	const relPath = path.relative(templateRoot, filePath);

	return getDocumentSymbols(relPath, projectIndex);
});

// Hover: show info for b-directives
connection.onHover((params: HoverParams) => {
	if (!templateRoot) return null;

	const uri = params.textDocument.uri;
	const doc = documents.get(uri);
	if (!doc) return null;

	const filePath = uri.replace('file://', '');
	const relPath = path.relative(templateRoot, filePath);

	const line = doc.getText({
		start: { line: params.position.line, character: 0 },
		end: { line: params.position.line + 1, character: 0 },
	});
	const ch = params.position.character;
	const hasAssetAttr = /~=["']/.test(line);
	connection.console.log(`[hover] file=${relPath} line=${params.position.line} ch=${ch} assetDirs=${assetDirs ? assetDirs.size : 'null'} hasAssetAttr=${hasAssetAttr} line=${JSON.stringify(line.trimEnd())}`);

	const result = getHover(doc, params.position, relPath, projectIndex, cssAnalysis, cssPaths, templateRoot, assetDirs);
	if (result) {
		const preview = typeof result.contents === 'object' && 'value' in result.contents
			? result.contents.value.substring(0, 80)
			: '(non-markdown)';
		connection.console.log(`[hover] result: ${preview}`);
	} else {
		connection.console.log(`[hover] result: null`);
	}
	return result;
});

// Completion: asset dir names and file paths
connection.onCompletion(async (params: CompletionParams): Promise<CompletionItem[]> => {
	if (!assetDirs || assetDirs.size === 0) return [];

	const doc = documents.get(params.textDocument.uri);
	if (!doc) return [];

	const line = doc.getText({
		start: { line: params.position.line, character: 0 },
		end: { line: params.position.line, character: params.position.character },
	});

	// Only complete inside ~ attributes
	// Check if we're inside a ~=" or ~=' context
	const tildeAttrMatch = line.match(/:?[a-zA-Z][a-zA-Z0-9-]*~=["']([^"']*)$/);
	if (!tildeAttrMatch) return [];

	const valueTyped = tildeAttrMatch[1];

	// If user typed @ or part of @name, complete asset dir names
	if (valueTyped === '@' || (valueTyped.startsWith('@') && !valueTyped.includes('/'))) {
		const prefix = valueTyped.substring(1); // strip @
		const items: CompletionItem[] = [];
		for (const name of assetDirs.keys()) {
			if (prefix && !name.startsWith(prefix)) continue;
			items.push({
				label: `@${name}/`,
				kind: CompletionItemKind.Folder,
				insertText: `@${name}/`,
			});
		}
		return items;
	}

	// If user typed @name/ or @name/sub/path, complete files within the directory
	const pathMatch = valueTyped.match(/^@([a-zA-Z0-9_-]+)\/(.*)$/);
	if (!pathMatch) return [];

	const dirName = pathMatch[1];
	const subpath = pathMatch[2];
	const dirPath = assetDirs.get(dirName);
	if (!dirPath) return [];

	try {
		const searchDir = path.join(dirPath, path.dirname(subpath));
		const prefix = path.basename(subpath);
		const entries = await fs.readdir(searchDir, { withFileTypes: true });
		const items: CompletionItem[] = [];
		for (const entry of entries) {
			if (prefix && !entry.name.startsWith(prefix)) continue;
			if (entry.name.startsWith('.')) continue;
			const relBase = subpath.includes('/')
				? path.dirname(subpath) + '/' + entry.name
				: entry.name;
			if (entry.isDirectory()) {
				items.push({
					label: entry.name + '/',
					kind: CompletionItemKind.Folder,
					insertText: `@${dirName}/${relBase}/`,
				});
			} else {
				items.push({
					label: entry.name,
					kind: CompletionItemKind.File,
					insertText: `@${dirName}/${relBase}`,
				});
			}
		}
		return items;
	} catch {
		return [];
	}
});

// Find All Matches: CSS selector → matching HTML elements
connection.onRequest('backflip/findMatchesForSelector', (params: { uri: string; line: number }) => {
	if (!templateRoot || !cssAnalysis || cssPaths.length === 0) return null;

	const filePath = params.uri.replace('file://', '');
	const relPath = path.relative(templateRoot, filePath);

	const matches = findElementsForSelector(relPath, params.line, cssAnalysis, cssPaths, templateRoot);
	if (!matches) return null;
	return { matches, templateRoot };
});

// Find All Selectors: HTML element → matching CSS rules
connection.onRequest('backflip/findSelectorsForElement', (params: { uri: string; line: number; character: number }) => {
	if (!templateRoot || !cssAnalysis) return null;

	const filePath = params.uri.replace('file://', '');
	const relPath = path.relative(templateRoot, filePath);

	const doc = documents.get(params.uri);
	if (!doc) return null;

	const lineText = doc.getText({
		start: { line: params.line, character: 0 },
		end: { line: params.line + 1, character: 0 },
	});

	const result = findRulesForElement(lineText, params.line, params.character, relPath, cssAnalysis);
	if (!result) return null;

	return {
		...result,
		cssPaths,
	};
});

// Preview Partial: generate preview HTML for a partial
connection.onRequest('backflip/previewPartial', async (params: { uri: string; partialName: string }) => {
	if (!templateRoot || compiledFiles.size === 0) return null;

	const filePath = params.uri.replace('file://', '');
	const relPath = path.relative(templateRoot, filePath);
	const compiledFile = compiledFiles.get(relPath);
	if (!compiledFile) return null;

	try {
		const nonce = crypto.randomBytes(16).toString('hex');
		// Lazily create a session temp dir for freshly generated dom-patch JS, so the
		// webview loads classes whose bfids match the previewed HTML (not stale build output).
		if (domPatchOutputDirs.length > 0 && !domPatchTmpDir) {
			domPatchTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'backflip-bfdom-'));
		}
		const result = await previewPartial({
			partialName: params.partialName,
			compiledFile,
			allFiles: compiledFiles,
			fileName: relPath,
			nonce,
			assetMap,
			domPatchOutputDirs: domPatchOutputDirs.length > 0 ? domPatchOutputDirs : undefined,
			domPatchOutDir: domPatchTmpDir,
		});
		const assetDirsObj: Record<string, string> | undefined = assetDirs
			? Object.fromEntries(assetDirs)
			: undefined;
		return {
			html: result.html,
			partialName: params.partialName,
			mockData: result.mockData,
			errors: result.errors,
			cssPaths: cssPaths.length > 0 ? cssPaths : undefined,
			templateRoot,
			assetDirs: assetDirsObj,
			domPatchDir: domPatchTmpDir,
			domPatchAssets: result.domPatchAssets,
		};
	} catch (err) {
		connection.console.error(`[backflip] preview error: ${err instanceof Error ? err.message : err}`);
		return null;
	}
});

// Get asset directory configuration
connection.onRequest('backflip/getAssetDirs', () => {
	if (!assetDirs) return null;
	return Object.fromEntries(assetDirs);
});

// Asset usage report
connection.onRequest('backflip/assetUsageReport', (params: { uri?: string }) => {
	if (!assetDirs || compiledFiles.size === 0) return null;

	const assets = discoverAssetFileInfos(assetDirs);
	const refs = collectAllAssetReferences(compiledFiles, assetDirs);
	let report = buildAssetUsageReport(assets, refs);

	// If a URI is provided, filter by asset dir and subpath
	let filterName: string | undefined;
	let scope: string | undefined;
	if (params?.uri) {
		const filePath = decodeURIComponent(params.uri.replace('file://', ''));
		for (const [name, dirPath] of assetDirs) {
			if (filePath === dirPath || filePath.startsWith(dirPath + '/')) {
				filterName = name;
				const relative = filePath.substring(dirPath.length + 1); // '' for root
				if (relative === '') {
					// Clicked on the asset dir root
					scope = `@${name}`;
					report = filterReport(report, { name });
				} else {
					// Check if it's a directory or file by looking for assets with this prefix
					const isDir = assets.some(a => a.name === name && a.subpath.startsWith(relative + '/'));
					if (isDir) {
						scope = `@${name}/${relative}/`;
						report = filterReport(report, { name, subpathPrefix: relative + '/' });
					} else {
						scope = `@${name}/${relative}`;
						report = filterReport(report, { name, subpath: relative });
					}
				}
				break;
			}
		}
	}

	const html = renderAssetReportHtml(report, { assetBaseUrl: '/__assets/', scope });
	const assetDirsObj = Object.fromEntries(assetDirs);
	return { html, assetName: scope ?? filterName, assetDirs: assetDirsObj, templateRoot };
});

connection.listen();
