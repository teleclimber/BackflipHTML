import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ExtensionContext } from 'vscode';
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind,
} from 'vscode-languageclient/node.js';
import { showSelectorsPanel, refreshSelectorsPanel, isSelectorsOpen, type SelectorsData } from './panels/selectors-panel.js';
import { MatchesTreeProvider, type MatchInfo } from './panels/matches-tree.js';
import { showPreviewPanel, refreshPreviewPanel, isPreviewOpen } from './panels/preview-panel.js';
import { showAssetReportPanel, refreshAssetReportPanel, isAssetReportOpen } from './panels/asset-report-panel.js';

let client: LanguageClient;

/** Walk asset directories and collect all subdirectory paths into a map for use with VS Code's `in` operator in `when` clauses. */
async function buildAssetDirPathMap(assetDirs: Record<string, string>): Promise<Record<string, boolean>> {
	const map: Record<string, boolean> = {};
	async function walk(dir: string): Promise<void> {
		map[dir] = true;
		try {
			const entries = await fs.promises.readdir(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory() && entry.name !== 'node_modules') {
					await walk(path.join(dir, entry.name));
				}
			}
		} catch {
			// ignore permission errors etc.
		}
	}
	for (const dirPath of Object.values(assetDirs)) {
		await walk(dirPath);
	}
	return map;
}

async function updateAssetDirContext(): Promise<void> {
	if (!client?.isRunning()) return;
	try {
		const assetDirsResult = await client.sendRequest<Record<string, string> | null>('backflip/getAssetDirs');
		if (assetDirsResult) {
			const pathMap = await buildAssetDirPathMap(assetDirsResult);
			vscode.commands.executeCommand('setContext', 'backflipHTML.assetDirPaths', pathMap);
		} else {
			vscode.commands.executeCommand('setContext', 'backflipHTML.assetDirPaths', undefined);
		}
	} catch {
		// ignore
	}
}

// Store last query params for auto-refresh
let lastSelectorsQuery: { uri: string; line: number; character: number } | null = null;
let lastMatchesQuery: { uri: string; line: number } | null = null;
let lastPreviewQuery: { uri: string; partialName: string } | null = null;
let lastAssetReportQuery: { uri?: string } | null = null;

export function activate(context: ExtensionContext): void {
	// Register command to open a file at a specific line/column
	const openFileAtLocationDisposable = vscode.commands.registerCommand(
		'backflipHTML.openFileAtLocation',
		async (args: { path: string; line: number; col: number }) => {
			const uri = vscode.Uri.file(args.path);
			try {
				const doc = await vscode.workspace.openTextDocument(uri);
				const editor = await vscode.window.showTextDocument(doc);
				const position = new vscode.Position(args.line, args.col);
				editor.selection = new vscode.Selection(position, position);
				editor.revealRange(
					new vscode.Range(position, position),
					vscode.TextEditorRevealType.InCenter,
				);
			} catch {
				// Fallback for binary files (images, etc.) that can't be opened as text
				await vscode.commands.executeCommand('vscode.open', uri);
			}
		},
	);
	context.subscriptions.push(openFileAtLocationDisposable);

	// Set up the matches tree view
	const matchesTreeProvider = new MatchesTreeProvider();
	const treeView = vscode.window.createTreeView('backflipHTML.matchesTree', {
		treeDataProvider: matchesTreeProvider,
	});
	context.subscriptions.push(treeView);

	// Find All Selectors command (HTML → CSS rules)
	const findAllSelectorsDisposable = vscode.commands.registerCommand(
		'backflipHTML.findAllSelectors',
		async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || !client?.isRunning()) return;

			const params = {
				uri: editor.document.uri.toString(),
				line: editor.selection.active.line,
				character: editor.selection.active.character,
			};
			lastSelectorsQuery = params;

			const result = await client.sendRequest<SelectorsData | null>('backflip/findSelectorsForElement', params);
			if (!result) {
				vscode.window.showInformationMessage('No CSS selectors match this element.');
				return;
			}
			showSelectorsPanel(result, context);
		},
	);
	context.subscriptions.push(findAllSelectorsDisposable);

	// Find All Matches command (CSS → HTML elements)
	const findAllMatchesDisposable = vscode.commands.registerCommand(
		'backflipHTML.findAllMatches',
		async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || !client?.isRunning()) return;

			const params = {
				uri: editor.document.uri.toString(),
				line: editor.selection.active.line,
			};
			lastMatchesQuery = params;

			const result = await client.sendRequest<{ matches: MatchInfo[]; templateRoot: string } | null>('backflip/findMatchesForSelector', params);
			if (!result || result.matches.length === 0) {
				vscode.window.showInformationMessage('No HTML elements match this selector.');
				return;
			}

			// Extract selector text (everything before the opening brace)
			const lineText = editor.document.lineAt(params.line).text;
			const selectorText = lineText.replace(/\s*\{.*$/, '').trim();
			matchesTreeProvider.setData(result.matches, selectorText, result.templateRoot);
			treeView.title = `Matches for "${selectorText}"`;
			await vscode.commands.executeCommand('backflipHTML.matchesTree.focus');
		},
	);
	context.subscriptions.push(findAllMatchesDisposable);

	// Preview Partial command
	const previewPartialDisposable = vscode.commands.registerCommand(
		'backflipHTML.previewPartial',
		async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || !client?.isRunning()) return;

			// Find which partial the cursor is in by checking document symbols
			const symbols = await client.sendRequest<Array<{ name: string; range: { start: { line: number }; end: { line: number } } }> | null>(
				'textDocument/documentSymbol',
				{ textDocument: { uri: editor.document.uri.toString() } },
			);
			if (!symbols || symbols.length === 0) {
				vscode.window.showInformationMessage('No partials found in this file.');
				return;
			}

			// Find the partial containing the cursor
			const cursorLine = editor.selection.active.line;
			let partialName: string | null = null;
			for (const sym of symbols) {
				if (cursorLine >= sym.range.start.line && cursorLine <= sym.range.end.line) {
					partialName = sym.name;
					break;
				}
			}

			if (!partialName) {
				// If cursor is not in any partial, let user pick from list
				const names = symbols.map(s => s.name);
				const picked = await vscode.window.showQuickPick(names, { placeHolder: 'Select a partial to preview' });
				if (!picked) return;
				partialName = picked;
			}

			const params = {
				uri: editor.document.uri.toString(),
				partialName,
			};
			lastPreviewQuery = params;

			const result = await client.sendRequest<{ html: string; partialName: string; cssPaths?: string[]; templateRoot?: string; assetDirs?: Record<string, string>; domPatchDir?: string; domPatchAssets?: Record<string, string> } | null>('backflip/previewPartial', params);
			if (!result) {
				vscode.window.showInformationMessage('Could not generate preview for this partial.');
				return;
			}
			showPreviewPanel(result.html, result.partialName, context, result.cssPaths, result.templateRoot, result.assetDirs, result.domPatchDir, result.domPatchAssets);
		},
	);
	context.subscriptions.push(previewPartialDisposable);

	// Asset Usage Report command
	const assetUsageReportDisposable = vscode.commands.registerCommand(
		'backflipHTML.assetUsageReport',
		async (resourceUri?: vscode.Uri) => {
			if (!client?.isRunning()) return;

			const params: { uri?: string } = {};
			if (resourceUri) {
				params.uri = resourceUri.toString();
			}
			lastAssetReportQuery = params;

			const result = await client.sendRequest<{ html: string; assetName?: string; assetDirs?: Record<string, string>; templateRoot?: string } | null>('backflip/assetUsageReport', params);
			if (!result) {
				vscode.window.showInformationMessage('No asset directories configured.');
				return;
			}
			const title = result.assetName
				? `Assets: ${result.assetName}`
				: 'Asset Usage Report';
			showAssetReportPanel(result.html, title, context, result.assetDirs, result.templateRoot);
		},
	);
	context.subscriptions.push(assetUsageReportDisposable);

	// Server is bundled inside the extension at server/server.cjs
	const serverModule = context.asAbsolutePath(
		path.join('server', 'server.cjs')
	);

	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: { module: serverModule, transport: TransportKind.ipc },
	};

	const clientOptions: LanguageClientOptions = {
		documentSelector: [
			{ scheme: 'file', language: 'html' },
			{ scheme: 'file', language: 'css' },
		],
		// File watching is handled by the language server's own native recursive
		// fs watcher (see lsp setupFileWatcher / lib/watch.ts), which — unlike
		// VS Code's suffix-glob watchers — also catches directory renames/moves.
		middleware: {
			provideHover: async (document, position, token, next) => {
				const result = await next(document, position, token);
				if (!result) return result;

				// Convert to trusted MarkdownString so command URIs are clickable
				const trusted = (Array.isArray(result.contents) ? result.contents : [result.contents]).map(c => {
					if (c instanceof vscode.MarkdownString) {
						const md = new vscode.MarkdownString(c.value);
						md.isTrusted = { enabledCommands: ['backflipHTML.openFileAtLocation'] };
						return md;
					}
					if (typeof c === 'object' && 'value' in c) {
						const md = new vscode.MarkdownString(c.value as string);
						md.isTrusted = { enabledCommands: ['backflipHTML.openFileAtLocation'] };
						return md;
					}
					return c;
				});
				return new vscode.Hover(trusted, result.range);
			},
		},
	};

	client = new LanguageClient(
		'backflipHTML',
		'BackflipHTML Language Server',
		serverOptions,
		clientOptions,
	);

	client.start().then(async () => {
		await updateAssetDirContext();

		// Listen for analysis updates to auto-refresh open panels
		client.onNotification('backflip/analysisUpdated', async () => {
			await updateAssetDirContext();

			if (isSelectorsOpen() && lastSelectorsQuery) {
				const result = await client.sendRequest<SelectorsData | null>('backflip/findSelectorsForElement', lastSelectorsQuery);
				if (result) {
					refreshSelectorsPanel(result);
				}
			}

			if (lastMatchesQuery) {
				const result = await client.sendRequest<{ matches: MatchInfo[]; templateRoot: string } | null>('backflip/findMatchesForSelector', lastMatchesQuery);
				if (result && result.matches.length > 0) {
					matchesTreeProvider.setData(result.matches, '', result.templateRoot);
				}
			}

			if (isPreviewOpen() && lastPreviewQuery) {
				const result = await client.sendRequest<{ html: string; partialName: string; cssPaths?: string[]; templateRoot?: string; assetDirs?: Record<string, string>; domPatchDir?: string; domPatchAssets?: Record<string, string> } | null>('backflip/previewPartial', lastPreviewQuery);
				if (result) {
					refreshPreviewPanel(result.html, result.partialName, result.cssPaths, result.templateRoot, result.assetDirs, result.domPatchDir, result.domPatchAssets);
				}
			}

			if (isAssetReportOpen() && lastAssetReportQuery) {
				const result = await client.sendRequest<{ html: string; assetName?: string; assetDirs?: Record<string, string> } | null>('backflip/assetUsageReport', lastAssetReportQuery);
				if (result) {
					const title = result.assetName ? `Assets: ${result.assetName}` : 'Asset Usage Report';
					refreshAssetReportPanel(result.html, title, result.assetDirs);
				}
			}
		});
	});
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) return undefined;
	return client.stop();
}
