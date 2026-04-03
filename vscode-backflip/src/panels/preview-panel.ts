import * as vscode from 'vscode';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

let panel: vscode.WebviewPanel | null = null;
let templateRoot: string | null = null;

function generateNonce(): string {
	return crypto.randomBytes(16).toString('hex');
}

export function showPreviewPanel(
	html: string,
	partialName: string,
	context: vscode.ExtensionContext,
	cssPaths?: string[],
	templateRootPath?: string,
): void {
	templateRoot = templateRootPath ?? null;

	if (panel) {
		panel.reveal();
	} else {
		const resourceRoots: vscode.Uri[] = [];
		if (cssPaths) {
			for (const cssPath of cssPaths) {
				resourceRoots.push(vscode.Uri.file(path.dirname(cssPath)));
			}
		}

		panel = vscode.window.createWebviewPanel(
			'backflipPreview',
			`Preview: ${partialName}`,
			vscode.ViewColumn.Beside,
			{
				enableScripts: true,
				localResourceRoots: resourceRoots.length > 0 ? resourceRoots : undefined,
			},
		);
		panel.onDidDispose(() => { panel = null; }, null, context.subscriptions);
		panel.webview.onDidReceiveMessage(handleMessage, null, context.subscriptions);
	}

	panel.title = `Preview: ${partialName}`;
	panel.webview.html = injectCssLinks(html, panel.webview, cssPaths);
}

export function refreshPreviewPanel(html: string, partialName: string, cssPaths?: string[], templateRootPath?: string): void {
	if (templateRootPath !== undefined) templateRoot = templateRootPath;
	if (panel) {
		panel.title = `Preview: ${partialName}`;
		panel.webview.html = injectCssLinks(html, panel.webview, cssPaths);
	}
}

async function handleMessage(message: { type: string; file?: string; line?: number; col?: number }): Promise<void> {
	if (message.type !== 'jumpToSource' || !message.file || !message.line) return;

	const absPath = templateRoot
		? path.resolve(templateRoot, message.file)
		: message.file;

	try {
		const doc = await vscode.workspace.openTextDocument(absPath);
		const line = Math.max(0, message.line - 1);
		const col = Math.max(0, (message.col ?? 1) - 1);
		const pos = new vscode.Position(line, col);
		const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
		editor.selection = new vscode.Selection(pos, pos);
		editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
	} catch {
		// File not found — ignore silently
	}
}

export function getNonce(): string {
	return generateNonce();
}

function injectCssLinks(html: string, webview: vscode.Webview, cssPaths?: string[]): string {
	if (!cssPaths || cssPaths.length === 0) return html;
	const linkTags = cssPaths.map(cssPath => {
		const cssUri = webview.asWebviewUri(vscode.Uri.file(cssPath));
		return `<link rel="stylesheet" href="${cssUri}">`;
	}).join('\n');
	if (html.includes('</head>')) {
		return html.replace('</head>', linkTags + '\n</head>');
	}
	return linkTags + '\n' + html;
}

export function isPreviewOpen(): boolean {
	return panel !== null;
}
