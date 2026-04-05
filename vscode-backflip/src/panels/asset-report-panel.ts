import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';

let panel: vscode.WebviewPanel | null = null;
let currentTemplateRoot: string | undefined;
let currentAssetDirs: Record<string, string> | undefined;

export function showAssetReportPanel(
	html: string,
	title: string,
	context: vscode.ExtensionContext,
	assetDirs?: Record<string, string>,
	templateRoot?: string,
): void {
	currentTemplateRoot = templateRoot;
	currentAssetDirs = assetDirs;

	if (panel) {
		panel.reveal();
	} else {
		const resourceRoots: vscode.Uri[] = [];
		if (assetDirs) {
			for (const dirPath of Object.values(assetDirs)) {
				resourceRoots.push(vscode.Uri.file(dirPath));
			}
		}

		panel = vscode.window.createWebviewPanel(
			'backflipAssetReport',
			title,
			vscode.ViewColumn.Beside,
			{
				enableScripts: true,
				localResourceRoots: resourceRoots.length > 0 ? resourceRoots : undefined,
			},
		);
		panel.onDidDispose(() => { panel = null; }, null, context.subscriptions);

		panel.webview.onDidReceiveMessage(
			(msg: { command: string; path?: string; file?: string; line?: number; col?: number }) => {
				if (msg.command === 'openAsset' && msg.path) {
					vscode.commands.executeCommand('vscode.open', vscode.Uri.file(msg.path));
				} else if (msg.command === 'openReference' && msg.file) {
					let absPath = '';
					if (currentTemplateRoot) {
						const p = path.join(currentTemplateRoot, msg.file);
						if (fs.existsSync(p)) {
							absPath = p;
						}
					}
					if (!absPath && currentAssetDirs) {
						for (const dirPath of Object.values(currentAssetDirs)) {
							const p = path.join(dirPath, msg.file);
							if (fs.existsSync(p)) {
								absPath = p;
								break;
							}
						}
					}
					if (!absPath) {
						absPath = msg.file;
					}

					vscode.commands.executeCommand('backflipHTML.openFileAtLocation', {
						path: absPath,
						line: (msg.line ?? 1) - 1,
						col: (msg.col ?? 1) - 1,
					});
				}
			},
			undefined,
			context.subscriptions,
		);
	}

	panel.title = title;
	panel.webview.html = rewriteAssetUrls(html, panel.webview, assetDirs);
}

export function refreshAssetReportPanel(html: string, title: string, assetDirs?: Record<string, string>): void {
	if (panel) {
		currentAssetDirs = assetDirs;
		panel.title = title;
		panel.webview.html = rewriteAssetUrls(html, panel.webview, assetDirs);
	}
}

export function isAssetReportOpen(): boolean {
	return panel !== null;
}

function rewriteAssetUrls(html: string, webview: vscode.Webview, assetDirs?: Record<string, string>): string {
	if (!assetDirs) return html;
	for (const [name, dirPath] of Object.entries(assetDirs)) {
		const prefix = `/__assets/${name}/`;
		let idx = html.indexOf(prefix);
		while (idx !== -1) {
			const start = idx + prefix.length;
			let end = start;
			while (end < html.length && html[end] !== '"' && html[end] !== "'" && html[end] !== ' ' && html[end] !== '>') {
				end++;
			}
			const subpath = html.slice(start, end);
			const fileUri = vscode.Uri.file(path.join(dirPath, subpath));
			const webviewUri = webview.asWebviewUri(fileUri).toString();
			html = html.slice(0, idx) + webviewUri + html.slice(end);
			idx = html.indexOf(prefix, idx + webviewUri.length);
		}
	}
	return html;
}
