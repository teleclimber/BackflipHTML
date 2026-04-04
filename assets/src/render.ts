import type { AssetUsageReport } from './types.js';

export interface RenderOptions {
	/** Base URL for loading asset files (e.g. "/__assets/"). */
	assetBaseUrl?: string;
	/** Include live-reload script. */
	liveReload?: boolean;
	/** Scope label shown in the heading (e.g. "@images/icons/"). */
	scope?: string;
}

/**
 * Render an asset usage report as a self-contained HTML page.
 */
export function renderAssetReportHtml(
	report: AssetUsageReport,
	options: RenderOptions = {},
): string {
	const { assetBaseUrl = '', liveReload = false, scope } = options;

	const VISIBLE_REFS = 4;

	const rows = report.entries.map(entry => {
		const { asset, references, isUsed } = entry;
		const badge = isUsed
			? '<span class="badge used">used</span>'
			: '<span class="badge unused">unused</span>';

		let thumbnail: string;
		if (asset.isImage) {
			const src = escapeAttr(assetBaseUrl + asset.name + '/' + asset.subpath);
			thumbnail = `<img class="thumb" src="${src}" alt="" loading="lazy" />`;
		} else {
			thumbnail = `<div class="thumb placeholder">${escapeHtml(asset.ext || '?')}</div>`;
		}

		const assetLink = `<a class="asset-link" href="#" data-asset-path="${escapeAttr(asset.absolutePath)}">`;

		let refList: string;
		if (references.length > 0) {
			const renderRef = (r: typeof references[0]) =>
				`<li><a class="ref-link" href="#" data-ref-file="${escapeAttr(r.templateFile)}" data-ref-line="${r.line}" data-ref-col="${r.column}"><code>${escapeHtml(r.templateFile)}</code> partial <code>${escapeHtml(r.partialName)}</code> line ${r.line}</a></li>`;

			const visible = references.slice(0, VISIBLE_REFS).map(renderRef).join('');
			const hidden = references.length > VISIBLE_REFS
				? `<li class="hidden-refs" style="display:none">${references.slice(VISIBLE_REFS).map(renderRef).join('')}</li>`
					+ `<li><button class="show-more">show ${references.length - VISIBLE_REFS} more</button></li>`
				: '';
			refList = `<div class="refs">${references.length} reference${references.length > 1 ? 's' : ''}</div><ul>${visible}${hidden}</ul>`;
		} else {
			refList = '<span class="no-refs">no references</span>';
		}

		return `<div class="entry" data-name="${escapeAttr(asset.name)}" data-used="${isUsed}">`
			+ assetLink + thumbnail + `</a>`
			+ `<div class="info">`
			+ `<div class="path">${assetLink}@${escapeHtml(asset.name)}/${escapeHtml(asset.subpath)}</a></div>`
			+ `<div class="meta">${badge} ${formatSize(asset.size)}</div>`
			+ refList
			+ `</div></div>`;
	}).join('\n');

	const liveReloadScript = liveReload
		? `<script>
(function() {
	const es = new EventSource('/__live-reload');
	es.onmessage = () => location.reload();
})();
</script>`
		: '';

	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Asset Usage Report</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui, sans-serif; max-width: 960px; margin: 0 auto; padding: 20px; color: #333; }
h1 { margin-bottom: 8px; }
.summary { margin-bottom: 16px; color: #666; }
.summary strong { color: #333; }
.controls { margin-bottom: 16px; display: flex; gap: 8px; flex-wrap: wrap; }
.controls button { padding: 4px 12px; border: 1px solid #ccc; border-radius: 4px; background: #fff; cursor: pointer; }
.controls button.active { background: #333; color: #fff; border-color: #333; }
.list { display: flex; flex-direction: column; gap: 12px; }
.entry { border: 1px solid #ddd; border-radius: 6px; padding: 12px; display: flex; gap: 16px; }
.entry[data-used="false"] { border-color: #e8a; background: #fff8f5; }
.thumb { width: 120px; height: 120px; object-fit: cover; border-radius: 4px; flex-shrink: 0; }
.thumb.placeholder { display: flex; align-items: center; justify-content: center; background: #eee; color: #999; font-size: 1rem; width: 120px; height: 120px; }
.asset-link { text-decoration: none; color: inherit; }
.asset-link:hover .thumb { outline: 2px solid #06c; }
.info { min-width: 0; flex: 1; }
.path { font-family: monospace; font-size: 1rem; word-break: break-all; }
.path .asset-link { color: #06c; }
.path .asset-link:hover { text-decoration: underline; }
.meta { margin-top: 4px; font-size: 0.9rem; color: #888; }
.badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 0.9rem; font-weight: 600; }
.badge.used { background: #d4edda; color: #155724; }
.badge.unused { background: #f8d7da; color: #721c24; }
.refs { margin-top: 6px; font-size: 1rem; color: #555; }
ul { margin-top: 4px; padding-left: 16px; font-size: 1rem; }
li { margin-bottom: 2px; }
.ref-link { color: #06c; text-decoration: none; cursor: pointer; }
.ref-link:hover { text-decoration: underline; }
.show-more { border: none; background: none; color: #06c; cursor: pointer; font-size: 1rem; padding: 0; }
.show-more:hover { text-decoration: underline; }
.no-refs { font-size: 0.9rem; color: #aaa; }
</style>
</head>
<body>
<h1>Asset Usage Report${scope ? `: <code>${escapeHtml(scope)}</code>` : ''}</h1>
<div class="summary">
<strong>${report.summary.totalAssets}</strong> assets:
<strong>${report.summary.usedAssets}</strong> used,
<strong>${report.summary.unusedAssets}</strong> unused.
<strong>${report.summary.totalReferences}</strong> total references.
</div>
<div class="controls">
<button class="active" data-filter="all">All</button>
<button data-filter="unused">Unused only</button>
${getAssetDirButtons(report)}
</div>
<div class="list">
${rows}
</div>
<script>
document.querySelector('.controls').addEventListener('click', (e) => {
	const btn = e.target.closest('button');
	if (!btn) return;
	document.querySelectorAll('.controls button').forEach(b => b.classList.remove('active'));
	btn.classList.add('active');
	const filter = btn.dataset.filter;
	document.querySelectorAll('.entry').forEach(el => {
		if (filter === 'all') el.style.display = '';
		else if (filter === 'unused') el.style.display = el.dataset.used === 'false' ? '' : 'none';
		else el.style.display = el.dataset.name === filter ? '' : 'none';
	});
});
document.addEventListener('click', (e) => {
	const showMore = e.target.closest('.show-more');
	if (showMore) {
		e.preventDefault();
		const hidden = showMore.closest('ul').querySelector('.hidden-refs');
		if (hidden) {
			hidden.style.display = '';
			hidden.replaceWith(...hidden.children);
		}
		showMore.closest('li').remove();
		return;
	}
});
(function() {
	if (typeof acquireVsCodeApi !== 'function') return;
	var vscode = acquireVsCodeApi();
	document.addEventListener('click', function(e) {
		var link = e.target.closest('.asset-link');
		if (link) {
			e.preventDefault();
			vscode.postMessage({ command: 'openAsset', path: link.dataset.assetPath });
			return;
		}
		var ref = e.target.closest('.ref-link');
		if (ref) {
			e.preventDefault();
			vscode.postMessage({ command: 'openReference', file: ref.dataset.refFile, line: Number(ref.dataset.refLine), col: Number(ref.dataset.refCol) });
		}
	});
})();
</script>
${liveReloadScript}
</body>
</html>`;
}

function getAssetDirButtons(report: AssetUsageReport): string {
	const names = new Set(report.entries.map(e => e.asset.name));
	if (names.size <= 1) return '';
	return Array.from(names).sort()
		.map(n => `<button data-filter="${escapeAttr(n)}">${escapeHtml(n)}</button>`)
		.join('');
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
