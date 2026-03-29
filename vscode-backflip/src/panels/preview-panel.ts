import * as vscode from 'vscode';
import * as path from 'node:path';

let panel: vscode.WebviewPanel | null = null;

export function showPreviewPanel(
	html: string,
	partialName: string,
	context: vscode.ExtensionContext,
	stylesheetPath?: string,
): void {
	if (panel) {
		panel.reveal();
	} else {
		const resourceRoots: vscode.Uri[] = [];
		if (stylesheetPath) {
			resourceRoots.push(vscode.Uri.file(path.dirname(stylesheetPath)));
		}

		panel = vscode.window.createWebviewPanel(
			'backflipPreview',
			`Preview: ${partialName}`,
			vscode.ViewColumn.Beside,
			{
				enableScripts: false,
				localResourceRoots: resourceRoots.length > 0 ? resourceRoots : undefined,
			},
		);
		panel.onDidDispose(() => { panel = null; }, null, context.subscriptions);
	}

	panel.title = `Preview: ${partialName}`;
	panel.webview.html = injectCssLink(html, panel.webview, stylesheetPath);
}

export function refreshPreviewPanel(html: string, partialName: string, stylesheetPath?: string): void {
	if (panel) {
		panel.title = `Preview: ${partialName}`;
		panel.webview.html = injectCssLink(html, panel.webview, stylesheetPath);
	}
}

function injectCssLink(html: string, webview: vscode.Webview, stylesheetPath?: string): string {
	if (!stylesheetPath) return html;
	const cssUri = webview.asWebviewUri(vscode.Uri.file(stylesheetPath));
	const linkTag = `<link rel="stylesheet" href="${cssUri}">`;
	if (html.includes('</head>')) {
		return html.replace('</head>', linkTag + '\n</head>');
	}
	return linkTag + '\n' + html;
}

export function isPreviewOpen(): boolean {
	return panel !== null;
}
