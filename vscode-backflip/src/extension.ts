import * as path from 'node:path';
import * as vscode from 'vscode';
import { workspace, ExtensionContext } from 'vscode';
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind,
} from 'vscode-languageclient/node.js';

let client: LanguageClient;

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

	client.start();
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) return undefined;
	return client.stop();
}
