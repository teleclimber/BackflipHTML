import * as csstree from 'css-tree';
import type { CssRule, CssProperty } from './types.js';

export function parseCssFile(cssContent: string): CssRule[] {
	const ast = csstree.parse(cssContent, { positions: true });
	const rules: CssRule[] = [];
	const mediaStack: string[] = [];

	const skipAtrules = new Set(['keyframes', 'font-face', 'import', 'charset', 'namespace']);

	csstree.walk(ast, {
		enter(node: csstree.CssNode) {
			if (node.type === 'Atrule') {
				if (node.name === 'media' && node.prelude) {
					mediaStack.push(csstree.generate(node.prelude));
				} else if (skipAtrules.has(node.name)) {
					return csstree.walk.skip;
				}
				return;
			}

			if (node.type === 'Rule') {
				const selectorText = csstree.generate(node.prelude);

				// Extract individual selectors from the SelectorList
				const selectors: string[] = [];
				if (node.prelude.type === 'SelectorList') {
					node.prelude.children.forEach((selector: csstree.CssNode) => {
						selectors.push(csstree.generate(selector));
					});
				} else {
					selectors.push(selectorText);
				}

				// Extract declarations
				const properties: CssProperty[] = [];
				if (node.block) {
					node.block.children.forEach((child: csstree.CssNode) => {
						if (child.type === 'Declaration') {
							properties.push({
								name: child.property,
								value: csstree.generate(child.value),
							});
						}
					});
				}

				const loc = node.loc;
				rules.push({
					selectorText,
					selectors,
					properties,
					mediaConditions: [...mediaStack],
					sourceLine: loc?.start.line ?? 0,
					sourceCol: loc?.start.column ?? 0,
				});
			}
		},
		leave(node: csstree.CssNode) {
			if (node.type === 'Atrule' && node.name === 'media') {
				mediaStack.pop();
			}
		},
	});

	return rules;
}
