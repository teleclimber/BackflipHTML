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
	assetDirs?: Record<string, string>,
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
		if (assetDirs) {
			for (const dirPath of Object.values(assetDirs)) {
				resourceRoots.push(vscode.Uri.file(dirPath));
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
	panel.webview.html = rewriteAssetUrls(injectCssLinks(html, panel.webview, cssPaths), panel.webview, assetDirs);
}

export function refreshPreviewPanel(html: string, partialName: string, cssPaths?: string[], templateRootPath?: string, assetDirs?: Record<string, string>): void {
	if (templateRootPath !== undefined) templateRoot = templateRootPath;
	if (panel) {
		panel.title = `Preview: ${partialName}`;
		panel.webview.html = rewriteAssetUrls(injectCssLinks(html, panel.webview, cssPaths), panel.webview, assetDirs);
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

function rewriteAssetUrls(html: string, webview: vscode.Webview, assetDirs?: Record<string, string>): string {
	if (!assetDirs) return html;
	for (const [name, dirPath] of Object.entries(assetDirs)) {
		const prefix = `/__assets/${name}/`;
		// Replace all occurrences of the asset prefix with webview URIs
		let idx = html.indexOf(prefix);
		while (idx !== -1) {
			// Find the end of the URL (quote, space, or closing angle bracket)
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
