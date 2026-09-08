import * as csstree from '@eslint/css-tree';
import type { CssUrlReference } from './types.js';

/**
 * Parse CSS content and extract all url() references.
 */
export function extractAssetUrlsFromCss(cssContent: string): CssUrlReference[] {
	const ast = csstree.parse(cssContent, { positions: true });
	const results: CssUrlReference[] = [];

	csstree.walk(ast, (node: csstree.CssNode) => {
		if (node.type === 'Url') {
			const url = node.value;
			if (url) {
				results.push({
					url,
					line: node.loc?.start.line ?? 0,
					column: node.loc?.start.column ?? 0,
				});
			}
		}
	});

	return results;
}
