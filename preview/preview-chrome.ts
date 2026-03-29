export interface ChromeOptions {
	cssHref?: string;
	fileName?: string;
	liveReload?: boolean;
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

/**
 * Wrap rendered partial HTML in a complete document for preview.
 * Detects whether the rendered HTML is already a full document
 * (has both <head> and <body>) and injects chrome accordingly.
 * Document-level partials get no preview banner; fragments do.
 */
export function wrapInChrome(html: string, partialName: string, options?: ChromeOptions): string {
	const cssHref = options?.cssHref ?? '';
	const fileName = options?.fileName ?? '';
	const hasHead = /<head[\s>]/i.test(html);
	const hasBody = /<body[\s>]/i.test(html);

	const liveReload = options?.liveReload ?? false;

	if (hasHead && hasBody) {
		return wrapDocumentLevel(html, cssHref, liveReload);
	}
	return wrapFragment(html, partialName, fileName, cssHref, liveReload);
}

function wrapFragment(html: string, partialName: string, fileName: string, cssHref: string, liveReload: boolean): string {
	const label = fileName
		? `${escapeHtml(fileName)} &rsaquo; <code>${escapeHtml(partialName)}</code>`
		: `<code>${escapeHtml(partialName)}</code>`;

	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Preview: ${escapeHtml(partialName)}</title>
<style>${PREVIEW_STYLES}${SLOT_PLACEHOLDER_STYLE}</style>
${cssHref ? `<link rel="stylesheet" href="${escapeHtml(cssHref)}">` : ''}
</head>
<body>
<div class="backflip-preview-bar">Preview: ${label}</div>
${html}
${liveReload ? RELOAD_SCRIPT : ''}
</body>
</html>`;
}

function wrapDocumentLevel(html: string, cssHref: string, liveReload: boolean): string {
	let result = '<!DOCTYPE html>\n' + html;

	if (cssHref) {
		const linkTag = `<link rel="stylesheet" href="${escapeHtml(cssHref)}">`;
		if (result.includes('</head>')) {
			result = result.replace('</head>', linkTag + '\n</head>');
		} else {
			result = linkTag + '\n' + result;
		}
	}

	if (liveReload) {
		if (result.includes('</body>')) {
			result = result.replace('</body>', RELOAD_SCRIPT + '\n</body>');
		} else {
			result += '\n' + RELOAD_SCRIPT;
		}
	}

	return result;
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
