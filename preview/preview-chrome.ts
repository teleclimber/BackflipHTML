export interface ChromeOptions {
	cssContent?: string;
	isDocumentLevel?: boolean;
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

/**
 * Wrap rendered partial HTML in a complete document for preview.
 */
export function wrapInChrome(html: string, partialName: string, options?: ChromeOptions): string {
	const css = options?.cssContent ?? '';
	const isDoc = options?.isDocumentLevel ?? false;

	if (isDoc) {
		return wrapDocumentLevel(html, partialName, css);
	}
	return wrapFragment(html, partialName, css);
}

function wrapFragment(html: string, partialName: string, css: string): string {
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Preview: ${escapeHtml(partialName)}</title>
<style>${PREVIEW_STYLES}${SLOT_PLACEHOLDER_STYLE}</style>
${css ? `<style>\n${css}\n</style>` : ''}
</head>
<body>
<div class="backflip-preview-bar">Preview: <code>${escapeHtml(partialName)}</code></div>
${html}
</body>
</html>`;
}

function wrapDocumentLevel(html: string, partialName: string, css: string): string {
	const injection = `<style>${PREVIEW_STYLES}${SLOT_PLACEHOLDER_STYLE}</style>
${css ? `<style>\n${css}\n</style>` : ''}
<div class="backflip-preview-bar" style="position:fixed;top:0;left:0;right:0;">Preview: <code>${escapeHtml(partialName)}</code></div>`;

	// Try to inject before </head>
	if (html.includes('</head>')) {
		return html.replace('</head>', injection + '\n</head>');
	}

	// Try to inject after <body> or <body ...>
	const bodyMatch = html.match(/<body[^>]*>/i);
	if (bodyMatch) {
		return html.replace(bodyMatch[0], bodyMatch[0] + '\n' + injection);
	}

	// Fallback: prepend
	return injection + '\n' + html;
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
