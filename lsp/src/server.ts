import {
	createConnection,
	TextDocuments,
	ProposedFeatures,
	InitializeParams,
	InitializeResult,
	TextDocumentSyncKind,
	DidSaveTextDocumentParams,
	DefinitionParams,
	ReferenceParams,
	DocumentSymbolParams,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { compileDirectory, type BackflipError } from '@backflip/html';
import { buildIndex, type ProjectIndex } from './index.js';
import { errorsToDiagnostics } from './diagnostics.js';
import { findDefinition } from './definition.js';
import { findReferences } from './references.js';
import { getDocumentSymbols } from './symbols.js';
import { parseBPartValue } from './parse-bpart.js';
import * as path from 'node:path';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let workspaceRoot = '';
let projectIndex: ProjectIndex = { partialDefs: new Map(), partialRefs: [] };
let recompileTimer: ReturnType<typeof setTimeout> | null = null;

connection.onInitialize((params: InitializeParams): InitializeResult => {
	workspaceRoot = params.workspaceFolders?.[0]?.uri?.replace('file://', '') ?? '';
	connection.console.log(`[backflip] initialize: workspaceRoot=${workspaceRoot}`);

	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Full,
			definitionProvider: true,
			referencesProvider: true,
			documentSymbolProvider: true,
		},
	};
});

connection.onInitialized(async () => {
	if (workspaceRoot) {
		await recompile();
	}
});

async function recompile(): Promise<void> {
	if (!workspaceRoot) return;

	try {
		const { directory, errors } = await compileDirectory(workspaceRoot);
		projectIndex = buildIndex(directory);
		connection.console.log(`[backflip] recompile: ${directory.files.size} files, ${errors.length} errors, ${projectIndex.partialDefs.size} partials, ${projectIndex.partialRefs.length} refs`);

		// Publish diagnostics
		const diagsByFile = errorsToDiagnostics(errors as BackflipError[]);

		// Clear all diagnostics first, then publish new ones
		for (const [filePath] of directory.files) {
			const uri = `file://${workspaceRoot}/${filePath}`;
			connection.sendDiagnostics({
				uri,
				diagnostics: diagsByFile.get(filePath) ?? [],
			});
		}

		// Also publish diagnostics for files without a specific file path
		const globalDiags = diagsByFile.get('');
		if (globalDiags && globalDiags.length > 0) {
			// Attach global errors to the workspace root
			connection.sendDiagnostics({
				uri: `file://${workspaceRoot}`,
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

// Recompile on save
connection.onDidSaveTextDocument((_params: DidSaveTextDocumentParams) => {
	scheduleRecompile();
});

// Also recompile when documents are opened
documents.onDidOpen(() => {
	scheduleRecompile();
});

// Go to Definition: b-part → b-name
connection.onDefinition((params: DefinitionParams) => {
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
	const relPath = path.relative(workspaceRoot, filePath);

	const { partialName, targetFile } = parseBPartValue(value);

	return findDefinition(partialName, targetFile, relPath, projectIndex, workspaceRoot);
});

// Find References: b-name → all b-part usages
connection.onReferences((params: ReferenceParams) => {
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
	const relPath = path.relative(workspaceRoot, filePath);

	return findReferences(partialName, relPath, projectIndex, workspaceRoot);
});

// Document Symbols: list partials in file
connection.onDocumentSymbol((params: DocumentSymbolParams) => {
	const uri = params.textDocument.uri;
	const filePath = uri.replace('file://', '');
	const relPath = path.relative(workspaceRoot, filePath);

	return getDocumentSymbols(relPath, projectIndex);
});

documents.listen(connection);
connection.listen();
