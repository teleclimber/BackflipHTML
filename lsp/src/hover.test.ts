import { describe, it } from 'node:test';
import { strictEqual, ok, match } from 'node:assert';
import { getHover, findRulesForElement, findElementsForSelector } from './hover.js';
import { makeIndex, makeLoc } from './test-helpers.js';
import { analyzeCss, type PartialSourceInfo } from '@backflip/css';

function makePartialInfo(templateFiles: Map<string, string>): Map<string, Map<string, PartialSourceInfo>> {
	const result = new Map<string, Map<string, PartialSourceInfo>>();
	// Simple regex scan for b-name partials
	for (const [file, html] of templateFiles) {
		const info = new Map<string, PartialSourceInfo>();
		const tagRegex = /<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*\bb-name="([^"]*)"[^>]*>/g;
		let m: RegExpExecArray | null;
		while ((m = tagRegex.exec(html)) !== null) {
			const tagName = m[1].toLowerCase();
			const partialName = m[2];
			const startOffset = m.index;
			const before = html.substring(0, startOffset);
			const startLine = (before.match(/\n/g) ?? []).length + 1;
			const lastNl = before.lastIndexOf('\n');
			const startCol = lastNl === -1 ? startOffset + 1 : startOffset - lastNl;
			const closeTag = `</${tagName}>`;
			const closeIdx = html.indexOf(closeTag, startOffset + m[0].length);
			const endOffset = closeIdx !== -1 ? closeIdx + closeTag.length : startOffset + m[0].length;
			const isDocumentLevel = ['html', 'head', 'body'].includes(tagName);
			info.set(partialName, { startOffset, endOffset, startLine, startCol, isDocumentLevel });
		}
		if (info.size === 0) {
			info.set('__root__', { startOffset: 0, endOffset: html.length, startLine: 1, startCol: 1, isDocumentLevel: false });
		}
		result.set(file, info);
	}
	return result;
}

function analyze(input: { cssContent: string; templateFiles: Map<string, string> }) {
	return analyzeCss({ ...input, partialInfo: makePartialInfo(input.templateFiles) });
}
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { Position } from 'vscode-languageserver';

/** Create a fake TextDocument from lines of text. */
function makeDoc(lines: string[]): TextDocument {
	const text = lines.join('\n');
	return {
		getText(range?: any): string {
			if (!range) return text;
			const allLines = text.split('\n');
			const startLine = range.start.line;
			const endLine = range.end.line;
			// Return the requested line range
			return allLines.slice(startLine, endLine).join('\n') + (endLine > startLine ? '\n' : '');
		},
	} as TextDocument;
}

function pos(line: number, character: number): Position {
	return { line, character };
}

function hoverValue(hover: ReturnType<typeof getHover>): string {
	if (!hover) return '';
	const contents = hover.contents as { kind: string; value: string };
	return contents.value;
}

describe('getHover', () => {
	describe('b-part', () => {
		it('shows partial info with slots and data', () => {
			const index = makeIndex(
				[{ file: 'components.html', name: 'card', loc: makeLoc(1, 1, 1, 20), exported: true, slots: ['default', 'header'], freeVars: ['title', 'items'] }],
				[],
			);
			const doc = makeDoc(['<div b-part="components.html#card"></div>']);
			const result = getHover(doc, pos(0, 20), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('**Partial** `card`'));
			ok(v.includes('`components.html`'));
			ok(v.includes('exported'));
			ok(v.includes('`default`'));
			ok(v.includes('`header`'));
			ok(v.includes('`title`'));
			ok(v.includes('`items`'));
		});

		it('shows not-found for unknown partial', () => {
			const index = makeIndex([], []);
			const doc = makeDoc(['<div b-part="components.html#missing"></div>']);
			const result = getHover(doc, pos(0, 20), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('not found'));
		});

		it('returns null when cursor is outside attribute value', () => {
			const index = makeIndex(
				[{ file: 'page.html', name: 'card', loc: makeLoc(1, 1, 1, 20), exported: false }],
				[],
			);
			const doc = makeDoc(['<div b-part="card" class="x"></div>']);
			// Cursor on "class"
			const result = getHover(doc, pos(0, 22), 'page.html', index);
			strictEqual(result, null);
		});

		it('shows same-file partial without file info', () => {
			const index = makeIndex(
				[{ file: 'page.html', name: 'card', loc: makeLoc(1, 1, 1, 20), exported: false, slots: [], freeVars: ['title'] }],
				[],
			);
			const doc = makeDoc(['<div b-part="#card"></div>']);
			const result = getHover(doc, pos(0, 15), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('**Partial** `card`'));
			ok(!v.includes('page.html'));
		});

		it('shows none for empty slots and data', () => {
			const index = makeIndex(
				[{ file: 'page.html', name: 'simple', loc: makeLoc(1, 1, 1, 20), exported: false, slots: [], freeVars: [] }],
				[],
			);
			const doc = makeDoc(['<div b-part="#simple"></div>']);
			const result = getHover(doc, pos(0, 16), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('**Slots:** none'));
			ok(v.includes('**Data:** none'));
		});

		it('shows rich data shape when dataShape is provided', () => {
			const dataShape = new Map<string, import('@backflip/html').DataShape>([
				['title', { usages: new Set(['printed'] as const) }],
				['user', {
					usages: new Set<import('@backflip/html').UsageKind>(),
					properties: new Map([
						['name', { usages: new Set(['printed'] as const) }],
						['email', { usages: new Set(['attribute'] as const), attributes: new Set(['href']) }],
					]),
				}],
				['items', { usages: new Set(['iterable', 'boolean'] as const) }],
			]);
			const index = makeIndex(
				[{ file: 'page.html', name: 'card', loc: makeLoc(1, 1, 1, 20), exported: false, freeVars: ['items', 'title', 'user'], dataShape }],
				[],
			);
			const doc = makeDoc(['<div b-part="#card"></div>']);
			const result = getHover(doc, pos(0, 15), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('`title`'), 'should include title');
			ok(v.includes('printed'), 'should show printed usage');
			ok(v.includes('.name'), 'should show property name');
			ok(v.includes('.email'), 'should show property email');
			ok(v.includes('attribute: href'), 'should show attribute name');
			ok(v.includes('iterable'), 'should show iterable usage');
			ok(v.includes('boolean'), 'should show boolean usage');
		});
	});

	describe('b-name', () => {
		it('shows partial definition info with refs', () => {
			const index = makeIndex(
				[{ file: 'page.html', name: 'card', loc: makeLoc(1, 1, 1, 20), exported: true, slots: ['default', 'footer'], freeVars: ['title'] }],
				[
					{ file: 'page.html', partialName: 'card', targetFile: null, loc: makeLoc(10, 1, 10, 20) },
					{ file: 'other.html', partialName: 'card', targetFile: 'page.html', loc: makeLoc(5, 1, 5, 20) },
				],
			);
			const doc = makeDoc(['<div b-name="card" b-export>']);
			const result = getHover(doc, pos(0, 16), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('**Partial** `card`'));
			ok(v.includes('Exported'));
			ok(v.includes('2 references'));
			ok(v.includes('`default`'));
			ok(v.includes('`footer`'));
			ok(v.includes('`title`'));
		});

		it('shows 0 references and none for empty slots/data', () => {
			const index = makeIndex(
				[{ file: 'page.html', name: 'lonely', loc: makeLoc(1, 1, 1, 20), exported: false, slots: [], freeVars: [] }],
				[],
			);
			const doc = makeDoc(['<div b-name="lonely">']);
			const result = getHover(doc, pos(0, 16), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('0 references'));
			ok(v.includes('Local'));
			ok(v.includes('**Slots:** none'));
			ok(v.includes('**Data:** none'));
		});
	});

	describe('b-in', () => {
		it('shows slot exists when slot is defined', () => {
			const index = makeIndex(
				[{ file: 'page.html', name: 'card', loc: makeLoc(1, 1, 1, 20), exported: false, slots: ['default', 'header'], freeVars: [] }],
				[],
			);
			const doc = makeDoc([
				'<div b-part="#card">',
				'  <b-unwrap b-in="header">Title</b-unwrap>',
				'</div>',
			]);
			const result = getHover(doc, pos(1, 20), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('`header`'));
			ok(v.includes('partial `card`'));
			ok(v.includes('✓ Slot exists'));
		});

		it('shows slot not found with available slots', () => {
			const index = makeIndex(
				[{ file: 'page.html', name: 'card', loc: makeLoc(1, 1, 1, 20), exported: false, slots: ['default', 'footer'], freeVars: [] }],
				[],
			);
			const doc = makeDoc([
				'<div b-part="#card">',
				'  <b-unwrap b-in="sidebar">Content</b-unwrap>',
				'</div>',
			]);
			const result = getHover(doc, pos(1, 22), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('`sidebar`'));
			ok(v.includes('✗ Slot not found'));
			ok(v.includes('`default`'));
			ok(v.includes('`footer`'));
		});

		it('shows error when no enclosing b-part found', () => {
			const index = makeIndex([], []);
			const doc = makeDoc([
				'<b-unwrap b-in="header">Title</b-unwrap>',
			]);
			const result = getHover(doc, pos(0, 18), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('enclosing b-part not found'));
		});
	});

	describe('b-slot', () => {
		it('shows slot info with parent partial', () => {
			const index = makeIndex([], []);
			const doc = makeDoc([
				'<div b-name="card">',
				'  <b-unwrap b-slot="header" />',
				'</div>',
			]);
			const result = getHover(doc, pos(1, 22), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('`header`'));
			ok(v.includes('partial `card`'));
		});

		it('shows default for bare b-slot', () => {
			const index = makeIndex([], []);
			const doc = makeDoc([
				'<div b-name="card">',
				'  <b-unwrap b-slot />',
				'</div>',
			]);
			const result = getHover(doc, pos(1, 15), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('`default`'));
			ok(v.includes('partial `card`'));
		});

		it('shows error when no enclosing b-name', () => {
			const index = makeIndex([], []);
			const doc = makeDoc([
				'<b-unwrap b-slot="header" />',
			]);
			const result = getHover(doc, pos(0, 20), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('enclosing b-name not found'));
		});
	});

	describe('b-data:', () => {
		it('shows used when var is in partial freeVars', () => {
			const index = makeIndex(
				[{ file: 'page.html', name: 'card', loc: makeLoc(1, 1, 1, 20), exported: false, slots: [], freeVars: ['title', 'items'] }],
				[],
			);
			const doc = makeDoc(['<div b-part="#card" b-data:title="pageTitle"></div>']);
			const result = getHover(doc, pos(0, 28), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('`title`'));
			ok(v.includes('partial `card`'));
			ok(v.includes('✓ Used in partial'));
		});

		it('shows not used when var is not in partial freeVars', () => {
			const index = makeIndex(
				[{ file: 'page.html', name: 'card', loc: makeLoc(1, 1, 1, 20), exported: false, slots: [], freeVars: ['title'] }],
				[],
			);
			const doc = makeDoc(['<div b-part="#card" b-data:unused="val"></div>']);
			const result = getHover(doc, pos(0, 28), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('`unused`'));
			ok(v.includes('✗ Not used in partial'));
		});

		it('shows error when no b-part on line', () => {
			const index = makeIndex([], []);
			const doc = makeDoc(['<div b-data:title="val"></div>']);
			const result = getHover(doc, pos(0, 14), 'page.html', index);
			const v = hoverValue(result);
			ok(v.includes('no b-part on this element'));
		});
	});

	describe('no match', () => {
		it('returns null for plain HTML without CSS analysis', () => {
			const index = makeIndex([], []);
			const doc = makeDoc(['<div class="foo">Hello</div>']);
			const result = getHover(doc, pos(0, 10), 'page.html', index);
			strictEqual(result, null);
		});
	});

	describe('CSS rules', () => {
		function makeCssAnalysis(file: string, matches: Array<{
			startLine: number;
			startCol: number;
			rules: Array<{ selector: string; specificity: [number, number, number]; properties?: Array<{ name: string; value: string }>; media?: string[]; matchType?: string; sourceLine?: number; sourceCol?: number }>;
		}>) {
			const elementMatches = new Map();
			elementMatches.set(file, matches.map(m => ({
				element: null,
				file,
				partialName: 'test',
				startLine: m.startLine,
				startCol: m.startCol,
				startOffset: 0,
				matches: m.rules.map(r => ({
					rule: {
						selectorText: r.selector,
						selectors: [r.selector],
						properties: r.properties ?? [],
						mediaConditions: r.media ?? [],
						sourceLine: r.sourceLine ?? 1,
						sourceCol: r.sourceCol ?? 1,
					},
					selector: r.selector,
					specificity: r.specificity,
					mediaConditions: r.media ?? [],
					matchType: r.matchType ?? 'definite',
				})),
			})));
			return { elementMatches, rules: [] };
		}

		it('shows CSS rules on hover', () => {
			const index = makeIndex([], []);
			const cssAnalysis = makeCssAnalysis('page.html', [{
				startLine: 1,
				startCol: 1,
				rules: [
					{ selector: '.card', specificity: [0, 1, 0], properties: [{ name: 'color', value: 'red' }] },
				],
			}]);
			const doc = makeDoc(['<div class="card">Hello</div>']);
			const result = getHover(doc, pos(0, 5), 'page.html', index, cssAnalysis as any);
			const v = hoverValue(result);
			ok(v.includes('**CSS Rules**'));
			ok(v.includes('`.card`'));
			ok(v.includes('(0, 1, 0)'));
			ok(v.includes('color: red'));
		});

		it('shows media conditions', () => {
			const index = makeIndex([], []);
			const cssAnalysis = makeCssAnalysis('page.html', [{
				startLine: 1,
				startCol: 1,
				rules: [
					{ selector: '.card', specificity: [0, 1, 0], media: ['(min-width:768px)'] },
				],
			}]);
			const doc = makeDoc(['<div class="card">Hello</div>']);
			const result = getHover(doc, pos(0, 5), 'page.html', index, cssAnalysis as any);
			const v = hoverValue(result);
			ok(v.includes('@media'));
			ok(v.includes('(min-width:768px)'));
		});

		it('shows match type for conditional matches', () => {
			const index = makeIndex([], []);
			const cssAnalysis = makeCssAnalysis('page.html', [{
				startLine: 1,
				startCol: 1,
				rules: [
					{ selector: 'span', specificity: [0, 0, 1], matchType: 'conditional' },
				],
			}]);
			const doc = makeDoc(['<span>Hello</span>']);
			const result = getHover(doc, pos(0, 2), 'page.html', index, cssAnalysis as any);
			const v = hoverValue(result);
			ok(v.includes('*conditional*'));
		});

		it('returns null when no CSS analysis available', () => {
			const index = makeIndex([], []);
			const doc = makeDoc(['<div class="card">Hello</div>']);
			const result = getHover(doc, pos(0, 5), 'page.html', index, null);
			strictEqual(result, null);
		});

		it('shows CSS file name and line number when stylesheetPath is provided', () => {
			const index = makeIndex([], []);
			const cssAnalysis = makeCssAnalysis('page.html', [{
				startLine: 1,
				startCol: 1,
				rules: [
					{ selector: '.card', specificity: [0, 1, 0], properties: [{ name: 'color', value: 'red' }], sourceLine: 10 },
				],
			}]);
			const doc = makeDoc(['<div class="card">Hello</div>']);
			const result = getHover(doc, pos(0, 5), 'page.html', index, cssAnalysis as any, '/workspace/styles.css');
			const v = hoverValue(result);
			ok(v.includes('styles.css:10'), 'should include file name and line number');
			ok(v.includes('command:backflipHTML.openCssRule'), 'should include command URI');
		});

		it('shows correct line numbers for multiple rules', () => {
			const index = makeIndex([], []);
			const cssAnalysis = makeCssAnalysis('page.html', [{
				startLine: 1,
				startCol: 1,
				rules: [
					{ selector: '.a', specificity: [0, 1, 0], sourceLine: 5 },
					{ selector: '.b', specificity: [0, 1, 0], sourceLine: 12 },
				],
			}]);
			const doc = makeDoc(['<div class="a b">Hello</div>']);
			const result = getHover(doc, pos(0, 5), 'page.html', index, cssAnalysis as any, '/workspace/theme.css');
			const v = hoverValue(result);
			ok(v.includes('theme.css:5'), 'should include first rule line');
			ok(v.includes('theme.css:12'), 'should include second rule line');
		});

		it('does not show file link when stylesheetPath is not provided', () => {
			const index = makeIndex([], []);
			const cssAnalysis = makeCssAnalysis('page.html', [{
				startLine: 1,
				startCol: 1,
				rules: [
					{ selector: '.card', specificity: [0, 1, 0] },
				],
			}]);
			const doc = makeDoc(['<div class="card">Hello</div>']);
			const result = getHover(doc, pos(0, 5), 'page.html', index, cssAnalysis as any);
			const v = hoverValue(result);
			ok(!v.includes('command:'), 'should not include command URI without stylesheetPath');
		});

		it('returns null when cursor not on HTML tag', () => {
			const index = makeIndex([], []);
			const cssAnalysis = makeCssAnalysis('page.html', [{
				startLine: 1,
				startCol: 1,
				rules: [{ selector: '.card', specificity: [0, 1, 0] }],
			}]);
			const doc = makeDoc(['Hello world']);
			const result = getHover(doc, pos(0, 5), 'page.html', index, cssAnalysis as any);
			strictEqual(result, null);
		});
	});
});

describe('CSS selector hover (hover in CSS file)', () => {
	function makeCssAnalysisWithElements(entries: Array<{
		file: string;
		partialName: string;
		startLine: number;
		startCol: number;
		selector: string;
		ruleLine: number;
		matchType?: string;
	}>) {
		const elementMatches = new Map<string, any[]>();
		for (const e of entries) {
			const arr = elementMatches.get(e.file) ?? [];
			// Check if there's already an element at this line
			let existing = arr.find((m: any) => m.startLine === e.startLine && m.startCol === e.startCol);
			if (!existing) {
				existing = {
					element: null,
					file: e.file,
					partialName: e.partialName,
					startLine: e.startLine,
					startCol: e.startCol,
					startOffset: 0,
					matches: [],
				};
				arr.push(existing);
			}
			existing.matches.push({
				rule: {
					selectorText: e.selector,
					selectors: [e.selector],
					properties: [],
					mediaConditions: [],
					sourceLine: e.ruleLine,
					sourceCol: 1,
				},
				selector: e.selector,
				specificity: [0, 1, 0] as [number, number, number],
				mediaConditions: [],
				matchType: e.matchType ?? 'definite',
			});
			elementMatches.set(e.file, arr);
		}
		return { elementMatches, rules: [] };
	}

	// stylesheetPath is absolute, templateRoot is absolute
	// filePath passed to getHover is path.relative(templateRoot, absoluteFilePath)
	// So for stylesheet at /workspace/styles.css and templateRoot /workspace/templates,
	// filePath would be ../styles.css
	const ssPath = '/workspace/styles.css';
	const tplRoot = '/workspace/templates';
	const ssRelPath = '../styles.css'; // path.relative(tplRoot, ssPath)

	it('shows matching partials when hovering on a CSS selector line', () => {
		const index = makeIndex([], []);
		const cssAnalysis = makeCssAnalysisWithElements([
			{ file: 'page.html', partialName: 'card', startLine: 5, startCol: 3, selector: '.card', ruleLine: 2 },
		]);
		const doc = makeDoc([
			'/* styles */',
			'.card {',
			'  color: red;',
			'}',
		]);
		const result = getHover(doc, pos(1, 3), ssRelPath, index, cssAnalysis as any, ssPath, tplRoot);
		const v = hoverValue(result);
		ok(v.includes('**Matched elements**'), 'should show matched elements header');
		ok(v.includes('card'), 'should show partial name');
		ok(v.includes('page.html'), 'should show file name');
	});

	it('shows multiple partials from different files', () => {
		const index = makeIndex([], []);
		const cssAnalysis = makeCssAnalysisWithElements([
			{ file: 'page.html', partialName: 'card', startLine: 5, startCol: 3, selector: '.title', ruleLine: 1 },
			{ file: 'other.html', partialName: 'header', startLine: 3, startCol: 1, selector: '.title', ruleLine: 1 },
		]);
		const doc = makeDoc(['.title { font-size: 16px; }']);
		const result = getHover(doc, pos(0, 3), ssRelPath, index, cssAnalysis as any, ssPath, tplRoot);
		const v = hoverValue(result);
		ok(v.includes('card'), 'should show first partial');
		ok(v.includes('header'), 'should show second partial');
		ok(v.includes('page.html'), 'should show first file');
		ok(v.includes('other.html'), 'should show second file');
	});

	it('includes clickable link to element location', () => {
		const index = makeIndex([], []);
		const cssAnalysis = makeCssAnalysisWithElements([
			{ file: 'page.html', partialName: 'card', startLine: 5, startCol: 3, selector: '.card', ruleLine: 1 },
		]);
		const doc = makeDoc(['.card { color: red; }']);
		const result = getHover(doc, pos(0, 3), ssRelPath, index, cssAnalysis as any, ssPath, tplRoot);
		const v = hoverValue(result);
		ok(v.includes('command:backflipHTML.openCssRule'), 'should include command URI');
		// Path is URL-encoded in the command URI
		ok(v.includes(encodeURIComponent('/workspace/templates/page.html')), 'should include full path to template');
	});

	it('shows match type for non-definite matches', () => {
		const index = makeIndex([], []);
		const cssAnalysis = makeCssAnalysisWithElements([
			{ file: 'page.html', partialName: 'card', startLine: 5, startCol: 3, selector: '.card', ruleLine: 1, matchType: 'conditional' },
		]);
		const doc = makeDoc(['.card { color: red; }']);
		const result = getHover(doc, pos(0, 3), ssRelPath, index, cssAnalysis as any, ssPath, tplRoot);
		const v = hoverValue(result);
		ok(v.includes('conditional'), 'should show match type');
	});

	it('returns null when hovering on a non-selector line (e.g. property)', () => {
		const index = makeIndex([], []);
		const cssAnalysis = makeCssAnalysisWithElements([
			{ file: 'page.html', partialName: 'card', startLine: 5, startCol: 3, selector: '.card', ruleLine: 1 },
		]);
		const doc = makeDoc([
			'.card {',
			'  color: red;',
			'}',
		]);
		const result = getHover(doc, pos(1, 5), ssRelPath, index, cssAnalysis as any, ssPath, tplRoot);
		strictEqual(result, null);
	});

	it('returns null when not hovering on the stylesheet file', () => {
		const index = makeIndex([], []);
		const cssAnalysis = makeCssAnalysisWithElements([
			{ file: 'page.html', partialName: 'card', startLine: 5, startCol: 3, selector: '.card', ruleLine: 1 },
		]);
		const doc = makeDoc(['.card { color: red; }']);
		const result = getHover(doc, pos(0, 3), 'other.css', index, cssAnalysis as any, ssPath, tplRoot);
		strictEqual(result, null);
	});

	it('returns null when no elements match the selector', () => {
		const index = makeIndex([], []);
		const cssAnalysis = makeCssAnalysisWithElements([
			{ file: 'page.html', partialName: 'card', startLine: 5, startCol: 3, selector: '.card', ruleLine: 3 },
		]);
		const doc = makeDoc(['.unmatched { color: red; }']);
		// Rule is on line 3, but we're hovering line 1 (0-based 0)
		const result = getHover(doc, pos(0, 3), ssRelPath, index, cssAnalysis as any, ssPath, tplRoot);
		strictEqual(result, null);
	});
});

describe('getHover integration (analyzeCss + getHover)', () => {
	it('shows CSS rules for elements inside a partial', () => {
		const html = [
			'<div b-name="card">',
			'  <div class="card-body">content</div>',
			'</div>',
		].join('\n');
		const css = '.card-body { padding: 8px; }';
		const cssAnalysis = analyze({
			cssContent: css,
			templateFiles: new Map([['page.html', html]]),
		});
		const doc = makeDoc(html.split('\n'));
		// Hover on the div.card-body (line 1, 0-based)
		const result = getHover(doc, pos(1, 5), 'page.html', makeIndex([], []), cssAnalysis);
		const v = hoverValue(result);
		ok(v.includes('**CSS Rules**'), 'should show CSS rules header');
		ok(v.includes('.card-body'), 'should show .card-body selector');
	});

	it('shows CSS rules for slot content (b-in) with ancestors inside the partial', () => {
		const html = [
			'<div b-name="card">',
			'  <div class="card-header">',
			'    <b-unwrap b-slot="header" />',
			'  </div>',
			'</div>',
			'<div b-part="#card">',
			'  <h2 b-in="header">Title</h2>',
			'</div>',
		].join('\n');
		const css = '.card-header h2 { color: red; }';
		const cssAnalysis = analyze({
			cssContent: css,
			templateFiles: new Map([['page.html', html]]),
		});
		const doc = makeDoc(html.split('\n'));
		// Hover on the h2 (line 6, 0-based)
		const result = getHover(doc, pos(6, 4), 'page.html', makeIndex([], []), cssAnalysis);
		const v = hoverValue(result);
		ok(v.includes('**CSS Rules**'), 'should show CSS rules for b-in element');
		ok(v.includes('.card-header h2'), 'should match descendant selector through slot');
	});

	it('shows CSS rules for slot content with ancestors above the calling partial', () => {
		const html = [
			'<div b-name="card">',
			'  <div class="card-body">',
			'    <b-unwrap b-slot />',
			'  </div>',
			'</div>',
			'<div class="page-wrapper">',
			'  <div b-part="#card">',
			'    <p b-in="default">Content</p>',
			'  </div>',
			'</div>',
		].join('\n');
		const css = '.page-wrapper .card-body p { margin: 0; }';
		const cssAnalysis = analyze({
			cssContent: css,
			templateFiles: new Map([['page.html', html]]),
		});
		const doc = makeDoc(html.split('\n'));
		// Hover on the p (line 7, 0-based)
		const result = getHover(doc, pos(7, 6), 'page.html', makeIndex([], []), cssAnalysis);
		const v = hoverValue(result);
		ok(v.includes('**CSS Rules**'), 'should show CSS rules for b-in element');
		ok(v.includes('.page-wrapper .card-body p'), 'should match selector spanning caller and partial');
	});

	it('shows CSS rules for slot content in cross-file partials', () => {
		const componentHtml = [
			'<div b-name="card" b-export>',
			'  <div class="card-header">',
			'    <b-unwrap b-slot="header" />',
			'  </div>',
			'</div>',
		].join('\n');
		const pageHtml = [
			'<div b-part="components.html#card">',
			'  <span b-in="header">Title</span>',
			'</div>',
		].join('\n');
		const css = '.card-header span { font-weight: bold; }';
		const cssAnalysis = analyze({
			cssContent: css,
			templateFiles: new Map([
				['components.html', componentHtml],
				['page.html', pageHtml],
			]),
		});
		const doc = makeDoc(pageHtml.split('\n'));
		// Hover on the span (line 1, 0-based)
		const result = getHover(doc, pos(1, 4), 'page.html', makeIndex([], []), cssAnalysis);
		const v = hoverValue(result);
		ok(v.includes('**CSS Rules**'), 'should show CSS rules for cross-file slot content');
		ok(v.includes('.card-header span'), 'should match selector from cross-file partial');
	});
});

describe('CSS selector hover integration (analyzeCss + getHover on CSS file)', () => {
	it('shows matching partials when hovering a selector in the CSS file', () => {
		const html = [
			'<div b-name="card">',
			'  <div class="card-body">content</div>',
			'</div>',
		].join('\n');
		const css = '.card-body { padding: 8px; }';
		const cssAnalysis = analyze({
			cssContent: css,
			templateFiles: new Map([['page.html', html]]),
		});
		const doc = makeDoc(css.split('\n'));
		// Hover on .card-body selector (line 0, 0-based) — rule is on line 1 (1-based)
		const result = getHover(doc, pos(0, 3), '../styles.css', makeIndex([], []), cssAnalysis, '/workspace/styles.css', '/workspace/templates');
		const v = hoverValue(result);
		ok(v.includes('**Matched elements**'), 'should show matched elements header');
		ok(v.includes('card'), 'should show partial name');
		ok(v.includes('page.html'), 'should show file name');
	});

	it('shows matches from multiple files', () => {
		const componentHtml = [
			'<div b-name="card" b-export>',
			'  <h2 class="title">heading</h2>',
			'</div>',
		].join('\n');
		const pageHtml = [
			'<div b-name="page">',
			'  <span class="title">page title</span>',
			'</div>',
		].join('\n');
		const css = '.title { color: blue; }';
		const cssAnalysis = analyze({
			cssContent: css,
			templateFiles: new Map([
				['components.html', componentHtml],
				['page.html', pageHtml],
			]),
		});
		const doc = makeDoc(css.split('\n'));
		const result = getHover(doc, pos(0, 3), '../styles.css', makeIndex([], []), cssAnalysis, '/workspace/styles.css', '/workspace/templates');
		const v = hoverValue(result);
		ok(v.includes('card'), 'should show card partial');
		ok(v.includes('page'), 'should show page partial');
		ok(v.includes('components.html'), 'should show components file');
		ok(v.includes('page.html'), 'should show page file');
	});
});

describe('findRulesForElement', () => {
	function makeCssAnalysis(file: string, matches: Array<{
		startLine: number;
		startCol: number;
		rules: Array<{
			selector: string;
			specificity: [number, number, number];
			properties?: Array<{ name: string; value: string }>;
			media?: string[];
			matchType?: string;
			sourceLine?: number;
			sourceCol?: number;
		}>;
	}>) {
		const elementMatches = new Map();
		elementMatches.set(file, matches.map(m => ({
			element: null,
			file,
			partialName: 'test',
			startLine: m.startLine,
			startCol: m.startCol,
			startOffset: 0,
			matches: m.rules.map(r => ({
				rule: {
					selectorText: r.selector,
					selectors: [r.selector],
					properties: r.properties ?? [],
					mediaConditions: r.media ?? [],
					sourceLine: r.sourceLine ?? 1,
					sourceCol: r.sourceCol ?? 1,
				},
				selector: r.selector,
				specificity: r.specificity,
				mediaConditions: r.media ?? [],
				matchType: r.matchType ?? 'definite',
			})),
		})));
		return { elementMatches, rules: [] };
	}

	it('returns structured data for matching element', () => {
		const cssAnalysis = makeCssAnalysis('page.html', [{
			startLine: 1,
			startCol: 1,
			rules: [
				{ selector: '.card', specificity: [0, 1, 0], properties: [{ name: 'color', value: 'red' }], sourceLine: 5, sourceCol: 3 },
			],
		}]);
		const result = findRulesForElement('<div class="card">Hello</div>', 0, 5, 'page.html', cssAnalysis as any);
		ok(result, 'should return a result');
		strictEqual(result!.tagName, 'div');
		strictEqual(result!.rules.length, 1);
		strictEqual(result!.rules[0].selector, '.card');
		strictEqual(result!.rules[0].specificity[1], 1);
		strictEqual(result!.rules[0].properties[0].name, 'color');
		strictEqual(result!.rules[0].sourceLine, 5);
	});

	it('returns null when no element matches', () => {
		const cssAnalysis = makeCssAnalysis('page.html', [{
			startLine: 2,
			startCol: 1,
			rules: [{ selector: '.card', specificity: [0, 1, 0] }],
		}]);
		const result = findRulesForElement('<div>Hello</div>', 0, 5, 'page.html', cssAnalysis as any);
		strictEqual(result, null);
	});

	it('returns null for non-tag lines', () => {
		const cssAnalysis = makeCssAnalysis('page.html', []);
		const result = findRulesForElement('Hello world', 0, 5, 'page.html', cssAnalysis as any);
		strictEqual(result, null);
	});
});

describe('findElementsForSelector', () => {
	function makeCssAnalysisWithElements(entries: Array<{
		file: string;
		partialName: string;
		startLine: number;
		startCol: number;
		selector: string;
		ruleLine: number;
		matchType?: string;
	}>) {
		const elementMatches = new Map<string, any[]>();
		for (const e of entries) {
			const arr = elementMatches.get(e.file) ?? [];
			let existing = arr.find((m: any) => m.startLine === e.startLine && m.startCol === e.startCol);
			if (!existing) {
				existing = {
					element: null,
					file: e.file,
					partialName: e.partialName,
					startLine: e.startLine,
					startCol: e.startCol,
					startOffset: 0,
					matches: [],
				};
				arr.push(existing);
			}
			existing.matches.push({
				rule: {
					selectorText: e.selector,
					selectors: [e.selector],
					properties: [],
					mediaConditions: [],
					sourceLine: e.ruleLine,
					sourceCol: 1,
				},
				selector: e.selector,
				specificity: [0, 1, 0] as [number, number, number],
				mediaConditions: [],
				matchType: e.matchType ?? 'definite',
			});
			elementMatches.set(e.file, arr);
		}
		return { elementMatches, rules: [] };
	}

	const ssPath = '/workspace/styles.css';
	const tplRoot = '/workspace/templates';
	const ssRelPath = '../styles.css';

	it('returns matching elements for a selector line', () => {
		const cssAnalysis = makeCssAnalysisWithElements([
			{ file: 'page.html', partialName: 'card', startLine: 5, startCol: 3, selector: '.card', ruleLine: 1 },
			{ file: 'page.html', partialName: 'header', startLine: 10, startCol: 1, selector: '.card', ruleLine: 1 },
		]);
		const result = findElementsForSelector(ssRelPath, 0, cssAnalysis as any, ssPath, tplRoot);
		ok(result, 'should return matches');
		strictEqual(result!.length, 2);
		strictEqual(result![0].partialName, 'card');
		strictEqual(result![1].partialName, 'header');
	});

	it('deduplicates by file + partialName + startLine', () => {
		const cssAnalysis = makeCssAnalysisWithElements([
			{ file: 'page.html', partialName: 'card', startLine: 5, startCol: 3, selector: '.a', ruleLine: 1 },
			{ file: 'page.html', partialName: 'card', startLine: 5, startCol: 3, selector: '.b', ruleLine: 1 },
		]);
		const result = findElementsForSelector(ssRelPath, 0, cssAnalysis as any, ssPath, tplRoot);
		ok(result, 'should return matches');
		strictEqual(result!.length, 1, 'should deduplicate');
	});

	it('returns null when not in stylesheet file', () => {
		const cssAnalysis = makeCssAnalysisWithElements([
			{ file: 'page.html', partialName: 'card', startLine: 5, startCol: 3, selector: '.card', ruleLine: 1 },
		]);
		const result = findElementsForSelector('other.css', 0, cssAnalysis as any, ssPath, tplRoot);
		strictEqual(result, null);
	});

	it('returns null when no matches on line', () => {
		const cssAnalysis = makeCssAnalysisWithElements([
			{ file: 'page.html', partialName: 'card', startLine: 5, startCol: 3, selector: '.card', ruleLine: 3 },
		]);
		const result = findElementsForSelector(ssRelPath, 0, cssAnalysis as any, ssPath, tplRoot);
		strictEqual(result, null);
	});

	it('preserves match type', () => {
		const cssAnalysis = makeCssAnalysisWithElements([
			{ file: 'page.html', partialName: 'card', startLine: 5, startCol: 3, selector: '.card', ruleLine: 1, matchType: 'conditional' },
		]);
		const result = findElementsForSelector(ssRelPath, 0, cssAnalysis as any, ssPath, tplRoot);
		ok(result);
		strictEqual(result![0].matchType, 'conditional');
	});
});
