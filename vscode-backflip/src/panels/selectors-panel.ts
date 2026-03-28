import * as vscode from 'vscode';
import * as path from 'node:path';

export interface SelectorsData {
	tagName: string;
	file: string;
	partialName: string;
	startLine: number;
	startCol: number;
	stylesheetPath: string;
	rules: Array<{
		selector: string;
		specificity: [number, number, number];
		matchType: 'definite' | 'conditional' | 'dynamic';
		properties: Array<{ name: string; value: string }>;
		mediaConditions: string[];
		sourceLine: number;
		sourceCol: number;
	}>;
}

let panel: vscode.WebviewPanel | null = null;

export function showSelectorsPanel(data: SelectorsData, context: vscode.ExtensionContext): void {
	if (panel) {
		panel.reveal();
	} else {
		panel = vscode.window.createWebviewPanel(
			'backflipSelectors',
			'CSS Rules',
			vscode.ViewColumn.Beside,
			{ enableScripts: true },
		);
		panel.onDidDispose(() => { panel = null; }, null, context.subscriptions);

		panel.webview.onDidReceiveMessage(
			(msg: { command: string; path: string; line: number; col: number }) => {
				if (msg.command === 'open') {
					vscode.commands.executeCommand('backflipHTML.openCssRule', {
						path: msg.path,
						line: msg.line,
						col: msg.col,
					});
				}
			},
			undefined,
			context.subscriptions,
		);
	}

	panel.title = `CSS Rules for <${data.tagName}>`;
	panel.webview.html = renderHtml(data);
}

export function refreshSelectorsPanel(data: SelectorsData): void {
	if (panel) {
		panel.title = `CSS Rules for <${data.tagName}>`;
		panel.webview.html = renderHtml(data);
	}
}

export function isSelectorsOpen(): boolean {
	return panel !== null;
}

function renderHtml(data: SelectorsData): string {
	const fileName = path.basename(data.stylesheetPath);
	const rows = data.rules.map(r => {
		const spec = `(${r.specificity.join(', ')})`;
		const typeClass = r.matchType !== 'definite' ? ` match-${r.matchType}` : '';
		const typeLabel = r.matchType !== 'definite' ? `<span class="match-type${typeClass}">${r.matchType}</span>` : '';
		const props = r.properties.map(p => `<span class="prop-name">${esc(p.name)}</span>: <span class="prop-value">${esc(p.value)}</span>`).join('; ');
		const media = r.mediaConditions.length > 0
			? `<div class="media">@media ${esc(r.mediaConditions.join(' and '))}</div>`
			: '';
		return `<div class="rule">
			<div class="rule-header">
				<code class="selector">${esc(r.selector)}</code>
				<span class="spec">${spec}</span>
				${typeLabel}
				<a class="location" href="#" data-path="${esc(data.stylesheetPath)}" data-line="${r.sourceLine - 1}" data-col="${r.sourceCol - 1}">${esc(fileName)}:${r.sourceLine}</a>
			</div>
			<div class="props">${props}</div>
			${media}
		</div>`;
	}).join('\n');

	return `<!DOCTYPE html>
<html>
<head>
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 12px; font-size: 13px; }
.summary { margin-bottom: 12px; opacity: 0.8; }
.rule { margin-bottom: 10px; padding: 8px; border: 1px solid var(--vscode-widget-border); border-radius: 4px; }
.rule-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.selector { font-weight: bold; color: var(--vscode-symbolIcon-fieldForeground, var(--vscode-foreground)); }
.spec { opacity: 0.6; font-size: 12px; }
.match-type { font-size: 11px; padding: 1px 5px; border-radius: 3px; }
.match-conditional { background: var(--vscode-editorWarning-foreground); color: var(--vscode-editor-background); }
.match-dynamic { background: var(--vscode-editorInfo-foreground); color: var(--vscode-editor-background); }
.props { margin-top: 4px; opacity: 0.85; }
.prop-name { color: var(--vscode-symbolIcon-propertyForeground, var(--vscode-foreground)); }
.media { margin-top: 4px; font-size: 12px; opacity: 0.6; }
.location { color: var(--vscode-textLink-foreground); text-decoration: none; font-size: 12px; margin-left: auto; }
.location:hover { text-decoration: underline; }
a { cursor: pointer; }
</style>
</head>
<body>
<div class="summary">${data.rules.length} rule${data.rules.length !== 1 ? 's' : ''} matching &lt;${esc(data.tagName)}&gt; in <strong>${esc(data.partialName)}</strong> (${esc(data.file)}:${data.startLine})</div>
${rows}
<script>
const vscode = acquireVsCodeApi();
document.addEventListener('click', (e) => {
	const a = e.target.closest('a.location');
	if (!a) return;
	e.preventDefault();
	vscode.postMessage({
		command: 'open',
		path: a.dataset.path,
		line: Number(a.dataset.line),
		col: Number(a.dataset.col),
	});
});
</script>
</body>
</html>`;
}

function esc(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
