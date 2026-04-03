export interface ChromeOptions {
	cssHrefs?: string[];
	fileName?: string;
	liveReload?: boolean;
	nonce?: string;
}

const PREVIEW_STYLES = `
	.backflip-preview-bar {
		background: #333; color: #fff; padding: 6px 14px; font: 13px/1.4 system-ui, sans-serif;
		position: sticky; top: 0; z-index: 99999;
	}
	.backflip-preview-bar code { background: #555; padding: 2px 6px; border-radius: 3px; }
`;

const SLOT_PLACEHOLDER_STYLE = `
	/* Slot placeholder styling is inline, no extra rules needed */
`;

const RELOAD_SCRIPT = `<script>(function(){var es=new EventSource("/__events");es.addEventListener("reload",function(){location.reload()})})();</script>`;

const CONTEXT_MENU_SCRIPT = `(function(){
var vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
var menu = null;

function findLoc(el) {
	while (el && el !== document.body) {
		if (el.dataset && el.dataset.loc) return el.dataset.loc;
		el = el.parentElement;
	}
	return null;
}

function removeMenu() {
	if (menu) { menu.remove(); menu = null; }
}

function parseLoc(loc) {
	var hashIdx = loc.indexOf('#');
	if (hashIdx === -1) return null;
	var file = loc.slice(0, hashIdx);
	var rest = loc.slice(hashIdx + 1);
	var parts = rest.split(':');
	if (parts.length < 3) return null;
	return { file: file, partial: parts[0], line: parseInt(parts[1], 10), col: parseInt(parts[2], 10) };
}

document.addEventListener('contextmenu', function(e) {
	var loc = findLoc(e.target);
	if (!loc || !vscode) return;
	e.preventDefault();
	removeMenu();

	var parsed = parseLoc(loc);
	if (!parsed) return;

	menu = document.createElement('div');
	menu.style.cssText = 'position:absolute;z-index:100000;background:#1f1f1f;color:#ccc;border:1px solid #444;border-radius:4px;padding:2px 0;font:13px/1.4 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3)';
	menu.style.left = e.pageX + 'px';
	menu.style.top = e.pageY + 'px';

	var label = document.createElement('div');
	label.style.cssText = 'padding:3px 20px;color:#888;font-size:11px;white-space:nowrap';
	label.textContent = parsed.partial;
	menu.appendChild(label);

	var item = document.createElement('div');
	item.style.cssText = 'padding:4px 20px;cursor:pointer;white-space:nowrap';
	item.textContent = 'Go to Source (' + parsed.file + ':' + parsed.line + ')';
	item.onmouseenter = function() { item.style.background = '#094771'; };
	item.onmouseleave = function() { item.style.background = 'none'; };
	item.onclick = function() {
		vscode.postMessage({ type: 'jumpToSource', file: parsed.file, line: parsed.line, col: parsed.col });
		removeMenu();
	};
	menu.appendChild(item);
	document.body.appendChild(menu);
});

document.addEventListener('click', removeMenu);
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') removeMenu(); });
})();`;

function contextMenuScript(nonce: string): string {
	return `<script nonce="${nonce}">${CONTEXT_MENU_SCRIPT}</script>`;
}

function cspMeta(nonce: string): string {
	return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https: vscode-resource:; script-src 'nonce-${nonce}';">`;
}

/**
 * Wrap rendered partial HTML in a complete document for preview.
 * Detects whether the rendered HTML is already a full document
 * (has both <head> and <body>) and injects chrome accordingly.
 * Document-level partials get no preview banner; fragments do.
 */
export function wrapInChrome(html: string, partialName: string, options?: ChromeOptions): string {
	const cssHrefs = options?.cssHrefs ?? [];
	const fileName = options?.fileName ?? '';
	const hasHead = /<head[\s>]/i.test(html);
	const hasBody = /<body[\s>]/i.test(html);

	const liveReload = options?.liveReload ?? false;
	const nonce = options?.nonce;

	if (hasHead && hasBody) {
		return wrapDocumentLevel(html, liveReload, nonce);
	}
	return wrapFragment(html, partialName, fileName, cssHrefs, liveReload, nonce);
}

function wrapFragment(html: string, partialName: string, fileName: string, cssHrefs: string[], liveReload: boolean, nonce?: string): string {
	const label = fileName
		? `${escapeHtml(fileName)} &rsaquo; <code>${escapeHtml(partialName)}</code>`
		: `<code>${escapeHtml(partialName)}</code>`;

	const cssLinks = cssHrefs.map(href => `<link rel="stylesheet" href="${escapeHtml(href)}">`).join('\n');

	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${nonce ? cspMeta(nonce) : ''}
<title>Preview: ${escapeHtml(partialName)}</title>
<style>${PREVIEW_STYLES}${SLOT_PLACEHOLDER_STYLE}</style>
${cssLinks}
</head>
<body>
<div class="backflip-preview-bar">Preview: ${label}</div>
${html}
${liveReload ? RELOAD_SCRIPT : ''}
${nonce ? contextMenuScript(nonce) : ''}
</body>
</html>`;
}

function wrapDocumentLevel(html: string, liveReload: boolean, nonce?: string): string {
	let result = '<!DOCTYPE html>\n' + html;

	if (nonce) {
		if (result.includes('</head>')) {
			result = result.replace('</head>', cspMeta(nonce) + '\n</head>');
		}
	}

	if (liveReload) {
		if (result.includes('</body>')) {
			result = result.replace('</body>', RELOAD_SCRIPT + '\n</body>');
		} else {
			result += '\n' + RELOAD_SCRIPT;
		}
	}

	if (nonce) {
		if (result.includes('</body>')) {
			result = result.replace('</body>', contextMenuScript(nonce) + '\n</body>');
		} else {
			result += '\n' + contextMenuScript(nonce);
		}
	}

	return result;
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
