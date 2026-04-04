import * as vscode from 'vscode';
import * as path from 'node:path';

let panel: vscode.WebviewPanel | null = null;
let currentTemplateRoot: string | undefined;

export function showAssetReportPanel(
	html: string,
	title: string,
	context: vscode.ExtensionContext,
	assetDirs?: Record<string, string>,
	templateRoot?: string,
): void {
	currentTemplateRoot = templateRoot;

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
					vscode.commands.executeCommand('backflipHTML.openCssRule', {
						path: msg.path,
						line: 0,
						col: 0,
					});
				} else if (msg.command === 'openReference' && msg.file) {
					const absPath = currentTemplateRoot
						? path.join(currentTemplateRoot, msg.file)
						: msg.file;
					vscode.commands.executeCommand('backflipHTML.openCssRule', {
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
