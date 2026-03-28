import {
	createConnection,
	TextDocuments,
	ProposedFeatures,
	InitializeParams,
	InitializeResult,
	TextDocumentSyncKind,
	DidChangeWatchedFilesParams,
	DefinitionParams,
	ReferenceParams,
	DocumentSymbolParams,
	HoverParams,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { compileDirectory, loadConfig, resolveConfigRoot, CONFIG_FILENAME, type BackflipError } from '@backflip/html';
import { analyzeCss, type CssAnalysisResult, type PartialSourceInfo } from '@backflip/css';
import { buildIndex, type ProjectIndex } from './index.js';
import { errorsToDiagnostics } from './diagnostics.js';
import { findDefinition } from './definition.js';
import { findReferences } from './references.js';
import { getDocumentSymbols } from './symbols.js';
import { parseBPartValue } from './parse-bpart.js';
import { getHover, findElementsForSelector, findRulesForElement } from './hover.js';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let workspaceRoot = '';
let templateRoot: string | null = null;
let stylesheetPath: string | null = null;
let projectIndex: ProjectIndex = { partialDefs: new Map(), partialRefs: [] };
let cssAnalysis: CssAnalysisResult | null = null;
let recompileTimer: ReturnType<typeof setTimeout> | null = null;
let knownFiles: Set<string> = new Set();

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
		},
	};
});

connection.onInitialized(async () => {
	if (workspaceRoot) {
		await loadAndApplyConfig();
	}
});

async function loadAndApplyConfig(): Promise<void> {
	try {
		const config = await loadConfig(workspaceRoot);
		if (!config) {
			connection.console.log(`[backflip] no ${CONFIG_FILENAME} found in ${workspaceRoot}, staying inactive`);
			templateRoot = null;
			stylesheetPath = null;
			cssAnalysis = null;
			clearAllDiagnostics();
			projectIndex = { partialDefs: new Map(), partialRefs: [] };
			return;
		}
		templateRoot = resolveConfigRoot(workspaceRoot, config);
		stylesheetPath = config.stylesheet
			? path.resolve(workspaceRoot, config.stylesheet)
			: null;
		connection.console.log(`[backflip] config loaded, template root: ${templateRoot}${stylesheetPath ? `, stylesheet: ${stylesheetPath}` : ''}`);
		await recompile();
	} catch (err) {
		connection.console.error(`[backflip] config error: ${err instanceof Error ? err.message : err}`);
		templateRoot = null;
		stylesheetPath = null;
		cssAnalysis = null;
		clearAllDiagnostics();
		projectIndex = { partialDefs: new Map(), partialRefs: [] };
	}
}

function clearAllDiagnostics(): void {
	for (const filePath of knownFiles) {
		const uri = `file://${templateRoot ?? workspaceRoot}/${filePath}`;
		connection.sendDiagnostics({ uri, diagnostics: [] });
	}
	knownFiles = new Set();
}

async function recompile(): Promise<void> {
	if (!templateRoot) return;

	try {
		const { directory, errors } = await compileDirectory(templateRoot);
		projectIndex = buildIndex(directory);
		connection.console.log(`[backflip] recompile: ${directory.files.size} files, ${errors.length} errors, ${projectIndex.partialDefs.size} partials, ${projectIndex.partialRefs.length} refs`);

		// Run CSS analysis if a stylesheet is configured
		cssAnalysis = null;
		if (stylesheetPath && templateRoot) {
			try {
				const cssContent = await fs.readFile(stylesheetPath, 'utf-8');
				const templateFiles = new Map<string, string>();
				const partialInfo = new Map<string, Map<string, PartialSourceInfo>>();
				for (const [filePath, compiledFile] of directory.files) {
					const fullPath = path.join(templateRoot, filePath);
					const html = await fs.readFile(fullPath, 'utf-8');
					templateFiles.set(filePath, html);
					const fileInfo = new Map<string, PartialSourceInfo>();
					for (const [name, root] of compiledFile.partials) {
						if (root.meta) fileInfo.set(name, root.meta);
					}
					partialInfo.set(filePath, fileInfo);
				}
				const cssStart = performance.now();
				cssAnalysis = analyzeCss({ cssContent, templateFiles, partialInfo });
				const cssElapsed = performance.now() - cssStart;
				const matchCount = Array.from(cssAnalysis.elementMatches.values())
					.reduce((sum, arr) => sum + arr.length, 0);
				connection.console.log(`[backflip] css analysis: ${cssAnalysis.rules.length} rules, ${matchCount} element matches (${cssElapsed.toFixed(0)}ms)`);
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

		// Also publish diagnostics for files without a specific file path
		const globalDiags = diagsByFile.get('');
		if (globalDiags && globalDiags.length > 0) {
			connection.sendDiagnostics({
				uri: `file://${templateRoot}`,
				diagnostics: globalDiags,
			});
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

// Handle file watcher events (for files not open in the editor, external edits, etc.)
connection.onDidChangeWatchedFiles((params: DidChangeWatchedFilesParams) => {
	const configChanged = params.changes.some(
		(c) => path.basename(c.uri.replace('file://', '')) === CONFIG_FILENAME
	);
	if (configChanged) {
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

	const { partialName, targetFile } = parseBPartValue(value);

	return findDefinition(partialName, targetFile, relPath, projectIndex, templateRoot);
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

	return getHover(doc, params.position, relPath, projectIndex, cssAnalysis, stylesheetPath, templateRoot);
});

// Find All Matches: CSS selector → matching HTML elements
connection.onRequest('backflip/findMatchesForSelector', (params: { uri: string; line: number }) => {
	if (!templateRoot || !cssAnalysis || !stylesheetPath) return null;

	const filePath = params.uri.replace('file://', '');
	const relPath = path.relative(templateRoot, filePath);

	const matches = findElementsForSelector(relPath, params.line, cssAnalysis, stylesheetPath, templateRoot);
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
		stylesheetPath,
	};
});

connection.listen();
