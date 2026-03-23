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
import { buildIndex, type ProjectIndex } from './index.js';
import { errorsToDiagnostics } from './diagnostics.js';
import { findDefinition } from './definition.js';
import { findReferences } from './references.js';
import { getDocumentSymbols } from './symbols.js';
import { parseBPartValue } from './parse-bpart.js';
import { getHover } from './hover.js';
import * as path from 'node:path';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let workspaceRoot = '';
let templateRoot: string | null = null;
let projectIndex: ProjectIndex = { partialDefs: new Map(), partialRefs: [] };
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
			clearAllDiagnostics();
			projectIndex = { partialDefs: new Map(), partialRefs: [] };
			return;
		}
		templateRoot = resolveConfigRoot(workspaceRoot, config);
		connection.console.log(`[backflip] config loaded, template root: ${templateRoot}`);
		await recompile();
	} catch (err) {
		connection.console.error(`[backflip] config error: ${err instanceof Error ? err.message : err}`);
		templateRoot = null;
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

// Also recompile when documents are opened
documents.onDidOpen(() => {
	scheduleRecompile();
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

	return getHover(doc, params.position, relPath, projectIndex);
});

connection.listen();
