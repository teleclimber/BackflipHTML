import * as vscode from 'vscode';

let panel: vscode.WebviewPanel | null = null;

export function showPreviewPanel(html: string, partialName: string, context: vscode.ExtensionContext): void {
	if (panel) {
		panel.reveal();
	} else {
		panel = vscode.window.createWebviewPanel(
			'backflipPreview',
			`Preview: ${partialName}`,
			vscode.ViewColumn.Beside,
			{ enableScripts: false },
		);
		panel.onDidDispose(() => { panel = null; }, null, context.subscriptions);
	}

	panel.title = `Preview: ${partialName}`;
	panel.webview.html = html;
}

export function refreshPreviewPanel(html: string, partialName: string): void {
	if (panel) {
		panel.title = `Preview: ${partialName}`;
		panel.webview.html = html;
	}
}

export function isPreviewOpen(): boolean {
	return panel !== null;
}
