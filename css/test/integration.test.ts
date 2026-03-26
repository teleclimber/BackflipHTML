import { describe, it, before } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';
import { analyzeCss } from '../src/index.js';
import type { CssAnalysisResult } from '../src/types.js';
// @ts-ignore — dist build has no .d.ts for render
import { compileDirectory, fileToJsModule } from '../../dist/mod.js';
// @ts-ignore
import { renderRoot } from '../../dist/runtime/js/render.js';

const FIXTURES = path.join(import.meta.dirname!, 'fixtures');
const TMPDIR = path.join(process.env.TMPDIR || '/tmp/claude-1000/', 'css-render-tests');

// ---------------------------------------------------------------------------
// Helpers: load fixtures for CSS analysis
// ---------------------------------------------------------------------------

function loadFixture(name: string) {
	const dir = path.join(FIXTURES, name);
	const cssContent = fs.readFileSync(path.join(dir, 'styles.css'), 'utf-8');
	const templatesDir = path.join(dir, 'templates');
	const templateFiles = new Map<string, string>();
	for (const file of fs.readdirSync(templatesDir)) {
		if (file.endsWith('.html')) {
			templateFiles.set(file, fs.readFileSync(path.join(templatesDir, file), 'utf-8'));
		}
	}
	return { cssContent, templateFiles };
}

function findMatchedRule(result: CssAnalysisResult, file: string, selector: string) {
	const entries = result.elementMatches.get(file);
	if (!entries) return null;
	for (const entry of entries) {
		const rule = entry.matches.find(m => m.selector === selector);
		if (rule) return rule;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Helpers: compile + render fixtures, query with jsdom
// ---------------------------------------------------------------------------

async function compileFixture(name: string): Promise<Map<string, Record<string, any>>> {
	const templatesDir = path.join(FIXTURES, name, 'templates');
	const { directory: compiled } = await compileDirectory(templatesDir);

	const jsFiles = new Map<string, string>();
	let hasCrossFile = false;
	for (const [filename, file] of compiled.files) {
		const js = fileToJsModule(file, filename);
		jsFiles.set(filename, js);
		if (js.includes('import ')) hasCrossFile = true;
	}

	const modules = new Map<string, Record<string, any>>();

	if (hasCrossFile) {
		const outDir = path.join(TMPDIR, name);
		await fsp.mkdir(outDir, { recursive: true });
		for (const [filename, js] of jsFiles) {
			await fsp.writeFile(path.join(outDir, filename.replace('.html', '.js')), js);
		}
		for (const filename of jsFiles.keys()) {
			const jsUrl = `file://${path.join(outDir, filename.replace('.html', '.js'))}?t=${Date.now()}`;
			modules.set(filename, await import(jsUrl));
		}
	} else {
		for (const [filename, js] of jsFiles) {
			const exportNames: string[] = [];
			const pattern = /^export const (\w+)/gm;
			let m;
			while ((m = pattern.exec(js)) !== null) exportNames.push(m[1]);
			const code = js.replace(/^export const /gm, 'const ');
			modules.set(filename, new Function(code + '\nreturn { ' + exportNames.join(', ') + ' };')());
		}
	}

	return modules;
}

function renderToDoc(modules: Map<string, Record<string, any>>, filename: string, partial: string, data: any = {}): Document {
	const mod = modules.get(filename);
	if (!mod) throw new Error(`No module for ${filename}`);
	if (!mod[partial]) throw new Error(`No partial "${partial}" in ${filename}`);
	const html = renderRoot(mod[partial], data);
	return new JSDOM(html).window.document;
}

// ---------------------------------------------------------------------------
// Helpers: data-mark comparison between jsdom and CSS analysis
// ---------------------------------------------------------------------------

/** Get data-mark values from jsdom elements matching a selector */
function jsdomMarks(doc: Document, selector: string): Set<string> {
	return new Set(
		[...doc.querySelectorAll(selector)]
			.map(el => el.getAttribute('data-mark'))
			.filter((m): m is string => m !== null)
	);
}

/** Get data-mark values from CSS analysis elements matching a selector in a given file */
function cssMarks(result: CssAnalysisResult, file: string, selector: string): Set<string> {
	const entries = result.elementMatches.get(file) || [];
	const marks = new Set<string>();
	for (const entry of entries) {
		if (entry.matches.some(m => m.selector === selector)) {
			const mark = entry.element.attrs?.find((a: any) => a.name === 'data-mark')?.value;
			if (mark) marks.add(mark);
		}
	}
	return marks;
}

/**
 * Assert that CSS analysis found the same elements as jsdom for a given selector.
 * jsdom marks must be a subset of CSS marks (CSS may find additional elements
 * in conditional branches that jsdom doesn't render with the given data).
 */
function assertCssFindsJsdom(
	result: CssAnalysisResult, doc: Document,
	file: string, selector: string,
	msg?: string,
) {
	const jMarks = jsdomMarks(doc, selector);
	const cMarks = cssMarks(result, file, selector);
	ok(jMarks.size > 0, `${msg ?? selector}: jsdom should find elements`);
	for (const mark of jMarks) {
		ok(cMarks.has(mark),
			`${msg ?? selector}: CSS analysis missing element [data-mark="${mark}"] that jsdom found`);
	}
}

/**
 * Assert exact match: CSS analysis and jsdom found exactly the same marked elements.
 */
function assertCssEqualsJsdom(
	result: CssAnalysisResult, doc: Document,
	file: string, selector: string,
	msg?: string,
) {
	const jMarks = jsdomMarks(doc, selector);
	const cMarks = cssMarks(result, file, selector);
	ok(jMarks.size > 0, `${msg ?? selector}: jsdom should find elements`);
	deepStrictEqual(cMarks, jMarks,
		`${msg ?? selector}: CSS analysis and jsdom should find the same elements`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('integration: simple', () => {
	let result: CssAnalysisResult;
	let doc: Document;

	before(async () => {
		result = analyzeCss(loadFixture('simple'));
		const modules = await compileFixture('simple');
		doc = renderToDoc(modules, 'page.html', 'page');
	});

	it('parses all CSS rules', () => {
		strictEqual(result.rules.length, 4);
	});

	it('matches .card on the same element as jsdom', () => {
		assertCssEqualsJsdom(result, doc, 'page.html', '.card');
	});

	it('matches .title on the same element as jsdom', () => {
		assertCssEqualsJsdom(result, doc, 'page.html', '.title');
	});

	it('matches #main on the same element as jsdom', () => {
		assertCssEqualsJsdom(result, doc, 'page.html', '#main');
	});

	it('matches div on the same elements as jsdom', () => {
		assertCssFindsJsdom(result, doc, 'page.html', 'div');
	});

	it('sorts matches by specificity (highest first)', () => {
		const entries = result.elementMatches.get('page.html')!;
		const el = entries.find(e => e.matches.length === 3);
		ok(el, 'should have element with 3 matches');
		strictEqual(el.matches[0].selector, '#main');
		strictEqual(el.matches[1].selector, '.card');
		strictEqual(el.matches[2].selector, 'div');
	});
});

describe('integration: multi-file', () => {
	let result: CssAnalysisResult;
	let doc: Document;

	before(async () => {
		result = analyzeCss(loadFixture('multi-file'));
		const modules = await compileFixture('multi-file');
		doc = renderToDoc(modules, 'page.html', 'page');
	});

	it('matches .card-inner on the same element as jsdom', () => {
		assertCssEqualsJsdom(result, doc, 'components.html', '.card-inner');
	});

	it('matches .card-title on the same element as jsdom', () => {
		assertCssEqualsJsdom(result, doc, 'components.html', '.card-title');
	});

	it('matches .page-wrapper .card-inner across partial boundary, same as jsdom', () => {
		assertCssEqualsJsdom(result, doc, 'components.html', '.page-wrapper .card-inner');
	});

	it('matches .page-wrapper .card-title across partial boundary, same as jsdom', () => {
		assertCssEqualsJsdom(result, doc, 'components.html', '.page-wrapper .card-title');
	});
});

describe('integration: slots', () => {
	let result: CssAnalysisResult;
	let doc: Document;

	before(async () => {
		result = analyzeCss(loadFixture('slots'));
		const modules = await compileFixture('slots');
		doc = renderToDoc(modules, 'page.html', 'page');
	});

	it('matches .card-header h2 on slot-injected content, same as jsdom', () => {
		assertCssEqualsJsdom(result, doc, 'page.html', '.card-header h2');
	});

	it('matches .card-body p on deeply nested slot content, same as jsdom', () => {
		assertCssEqualsJsdom(result, doc, 'page.html', '.card-body p');
	});

	it('matches .card-body ul li on deeply nested slot content, same as jsdom', () => {
		assertCssEqualsJsdom(result, doc, 'page.html', '.card-body ul li');
	});

	it('matches .container .card-header h2 spanning caller and partial, same as jsdom', () => {
		assertCssEqualsJsdom(result, doc, 'page.html', '.container .card-header h2');
	});

	it('matches .container .card-body ul spanning caller, partial, and nested slot content, same as jsdom', () => {
		assertCssEqualsJsdom(result, doc, 'page.html', '.container .card-body ul');
	});
});

describe('integration: media-queries', () => {
	let result: CssAnalysisResult;
	let doc: Document;

	before(async () => {
		result = analyzeCss(loadFixture('media-queries'));
		const modules = await compileFixture('media-queries');
		doc = renderToDoc(modules, 'page.html', 'page');
	});

	it('matches .sidebar on the same element as jsdom, with no media condition', () => {
		assertCssFindsJsdom(result, doc, 'page.html', '.sidebar');
		const rule = findMatchedRule(result, 'page.html', '.sidebar');
		ok(rule);
		strictEqual(rule.mediaConditions.length, 0);
	});

	it('matches .sidebar inside @media (max-width: 768px)', () => {
		const entries = result.elementMatches.get('page.html')!;
		const sidebarMatches = entries
			.flatMap(e => e.matches)
			.filter(m => m.selector === '.sidebar');
		const mediaMatch = sidebarMatches.find(m => m.mediaConditions.length > 0);
		ok(mediaMatch, 'should have a .sidebar match with media conditions');
		ok(mediaMatch.mediaConditions.some(c => c.includes('max-width')));
		// The element is the same one jsdom finds
		assertCssFindsJsdom(result, doc, 'page.html', '.sidebar');
	});

	it('matches .content inside @media print, on the same element as jsdom', () => {
		assertCssFindsJsdom(result, doc, 'page.html', '.content');
		const entries = result.elementMatches.get('page.html')!;
		const contentMatches = entries
			.flatMap(e => e.matches)
			.filter(m => m.selector === '.content');
		const printMatch = contentMatches.find(m =>
			m.mediaConditions.some(c => c.includes('print'))
		);
		ok(printMatch, '.content should match inside @media print');
	});

	it('has the correct total number of rules', () => {
		strictEqual(result.rules.length, 5);
	});
});

describe('integration: dynamic-classes', () => {
	let result: CssAnalysisResult;
	let docNoData: Document;
	let docWithClass: Document;

	before(async () => {
		result = analyzeCss(loadFixture('dynamic-classes'));
		const modules = await compileFixture('dynamic-classes');
		docNoData = renderToDoc(modules, 'page.html', 'page', {});
		docWithClass = renderToDoc(modules, 'page.html', 'page', { activeClass: 'btn-primary' });
	});

	it('matches .btn on the same element as jsdom, with matchType dynamic', () => {
		assertCssEqualsJsdom(result, docNoData, 'page.html', '.btn');
		const rule = findMatchedRule(result, 'page.html', '.btn');
		ok(rule);
		strictEqual(rule.matchType, 'dynamic');
	});

	it('matches .label on the same element as jsdom, with matchType definite', () => {
		assertCssEqualsJsdom(result, docNoData, 'page.html', '.label');
		const rule = findMatchedRule(result, 'page.html', '.label');
		ok(rule);
		strictEqual(rule.matchType, 'definite');
	});

	it('does not match .btn-primary in CSS analysis or jsdom (without dynamic data)', () => {
		const jMarks = jsdomMarks(docNoData, '.btn-primary');
		const cMarks = cssMarks(result, 'page.html', '.btn-primary');
		strictEqual(jMarks.size, 0, '.btn-primary should not match in jsdom without dynamic data');
		strictEqual(cMarks.size, 0, '.btn-primary should not match in CSS analysis');
	});

	it('jsdom finds .btn-primary with dynamic data (CSS analysis correctly does not — it is runtime-only)', () => {
		const jMarks = jsdomMarks(docWithClass, '.btn-primary');
		ok(jMarks.size > 0, '.btn-primary should match in jsdom when :class resolves');
		const cMarks = cssMarks(result, 'page.html', '.btn-primary');
		strictEqual(cMarks.size, 0, 'CSS analysis cannot predict dynamic class values');
	});

	it('.label matches in jsdom regardless of dynamic data', () => {
		assertCssEqualsJsdom(result, docNoData, 'page.html', '.label');
		assertCssEqualsJsdom(result, docWithClass, 'page.html', '.label');
	});
});

describe('integration: conditionals', () => {
	let result: CssAnalysisResult;
	let docBannerTrue: Document;
	let docBannerFalse: Document;

	before(async () => {
		result = analyzeCss(loadFixture('conditionals'));
		const modules = await compileFixture('conditionals');
		docBannerTrue = renderToDoc(modules, 'page.html', 'page', { showBanner: true });
		docBannerFalse = renderToDoc(modules, 'page.html', 'page', { showBanner: false });
	});

	it('matches .always-visible on the same element as jsdom (both branches)', () => {
		assertCssEqualsJsdom(result, docBannerTrue, 'page.html', '.always-visible');
		assertCssEqualsJsdom(result, docBannerFalse, 'page.html', '.always-visible');
		const rule = findMatchedRule(result, 'page.html', '.always-visible');
		ok(rule);
		strictEqual(rule.matchType, 'definite');
	});

	it('matches .banner on the same element as jsdom (showBanner=true), matchType conditional', () => {
		assertCssEqualsJsdom(result, docBannerTrue, 'page.html', '.banner');
		const rule = findMatchedRule(result, 'page.html', '.banner');
		ok(rule);
		strictEqual(rule.matchType, 'conditional');
	});

	it('matches .banner-text on the same element as jsdom (showBanner=true)', () => {
		assertCssFindsJsdom(result, docBannerTrue, 'page.html', '.banner-text');
	});

	it('CSS analysis finds .banner even when jsdom does not render it (showBanner=false)', () => {
		const jMarks = jsdomMarks(docBannerFalse, '.banner');
		strictEqual(jMarks.size, 0, '.banner should not render when showBanner=false');
		const cMarks = cssMarks(result, 'page.html', '.banner');
		ok(cMarks.size > 0, 'CSS analysis should still find .banner (conditional match)');
	});

	it('matches .fallback on the same element as jsdom (showBanner=false), matchType conditional', () => {
		assertCssEqualsJsdom(result, docBannerFalse, 'page.html', '.fallback');
		const rule = findMatchedRule(result, 'page.html', '.fallback');
		ok(rule);
		strictEqual(rule.matchType, 'conditional');
	});

	it('matches .fallback-text on the same element as jsdom (showBanner=false)', () => {
		assertCssFindsJsdom(result, docBannerFalse, 'page.html', '.fallback-text');
	});

	it('CSS analysis finds .fallback even when jsdom does not render it (showBanner=true)', () => {
		const jMarks = jsdomMarks(docBannerTrue, '.fallback');
		strictEqual(jMarks.size, 0, '.fallback should not render when showBanner=true');
		const cMarks = cssMarks(result, 'page.html', '.fallback');
		ok(cMarks.size > 0, 'CSS analysis should still find .fallback (conditional match)');
	});
});

describe('integration: nested-partials', () => {
	let result: CssAnalysisResult;
	let doc: Document;

	before(async () => {
		result = analyzeCss(loadFixture('nested-partials'));
		const modules = await compileFixture('nested-partials');
		doc = renderToDoc(modules, 'page.html', 'page');
	});

	it('matches .card-header span on the same element as jsdom', () => {
		assertCssEqualsJsdom(result, doc, 'page.html', '.card-header span');
	});

	it('matches .card-content p on the same element as jsdom', () => {
		assertCssEqualsJsdom(result, doc, 'page.html', '.card-content p');
	});

	it('matches .layout-body .card-header span spanning two partial boundaries, same as jsdom', () => {
		assertCssEqualsJsdom(result, doc, 'page.html', '.layout-body .card-header span');
	});

	it('matches .layout-body .card-content p spanning two partial boundaries, same as jsdom', () => {
		assertCssEqualsJsdom(result, doc, 'page.html', '.layout-body .card-content p');
	});
});

