import * as path from 'node:path';
import * as vscode from 'vscode';
import { workspace, ExtensionContext } from 'vscode';
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind,
} from 'vscode-languageclient/node.js';
import { showSelectorsPanel, refreshSelectorsPanel, isSelectorsOpen, type SelectorsData } from './panels/selectors-panel.js';
import { MatchesTreeProvider, type MatchInfo } from './panels/matches-tree.js';
import { showPreviewPanel, refreshPreviewPanel, isPreviewOpen } from './panels/preview-panel.js';

let client: LanguageClient;

// Store last query params for auto-refresh
let lastSelectorsQuery: { uri: string; line: number; character: number } | null = null;
let lastMatchesQuery: { uri: string; line: number } | null = null;
let lastPreviewQuery: { uri: string; partialName: string } | null = null;

export function activate(context: ExtensionContext): void {
	// Register command to open a CSS file at a specific line/column
	const openCssRuleDisposable = vscode.commands.registerCommand(
		'backflipHTML.openCssRule',
		async (args: { path: string; line: number; col: number }) => {
			const uri = vscode.Uri.file(args.path);
			const position = new vscode.Position(args.line, args.col);
			const doc = await vscode.workspace.openTextDocument(uri);
			const editor = await vscode.window.showTextDocument(doc);
			editor.selection = new vscode.Selection(position, position);
			editor.revealRange(
				new vscode.Range(position, position),
				vscode.TextEditorRevealType.InCenter,
			);
		},
	);
	context.subscriptions.push(openCssRuleDisposable);

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

			const result = await client.sendRequest<{ html: string; partialName: string } | null>('backflip/previewPartial', params);
			if (!result) {
				vscode.window.showInformationMessage('Could not generate preview for this partial.');
				return;
			}
			showPreviewPanel(result.html, result.partialName, context);
		},
	);
	context.subscriptions.push(previewPartialDisposable);

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
		synchronize: {
			fileEvents: [
				workspace.createFileSystemWatcher('**/*.html'),
				workspace.createFileSystemWatcher('**/*.css'),
				workspace.createFileSystemWatcher('**/backflip.json'),
			],
		},
		middleware: {
			provideHover: async (document, position, token, next) => {
				const result = await next(document, position, token);
				if (!result) return result;

				// Convert to trusted MarkdownString so command URIs are clickable
				const trusted = (Array.isArray(result.contents) ? result.contents : [result.contents]).map(c => {
					if (c instanceof vscode.MarkdownString) {
						const md = new vscode.MarkdownString(c.value);
						md.isTrusted = { enabledCommands: ['backflipHTML.openCssRule'] };
						return md;
					}
					if (typeof c === 'object' && 'value' in c) {
						const md = new vscode.MarkdownString(c.value as string);
						md.isTrusted = { enabledCommands: ['backflipHTML.openCssRule'] };
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

	client.start().then(() => {
		// Listen for analysis updates to auto-refresh open panels
		client.onNotification('backflip/analysisUpdated', async () => {
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
				const result = await client.sendRequest<{ html: string; partialName: string } | null>('backflip/previewPartial', lastPreviewQuery);
				if (result) {
					refreshPreviewPanel(result.html, result.partialName);
				}
			}
		});
	});
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) return undefined;
	return client.stop();
}
