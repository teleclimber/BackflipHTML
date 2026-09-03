import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { analyzeSource as analyze } from './test-helpers.js';
import type { CssAnalysisResult } from './types.js';

/** Helper: find an ElementMatches entry where one of the matched selectors equals `sel`. */
function findMatch(result: CssAnalysisResult, file: string, selector: string) {
	const entries = result.elementMatches.get(file);
	if (!entries) return null;
	return entries.find(e => e.matches.some(m => m.selector === selector)) ?? null;
}

describe('slot content CSS matching (integration)', () => {

	describe('same-file partial with slots', () => {
		it('matches b-in content against ancestors inside the partial', async () => {
			const result = await analyze({
				cssContent: '.card-header h2 { color: red; }',
				templateFiles: new Map([['page.html', [
					'<div b-name="card">',
					'  <div class="card-header">',
					'    <b-unwrap b-slot="header" />',
					'  </div>',
					'</div>',
					'<div b-name="page">',
					'  <div b-part="#card">',
					'    <h2 b-in="header">Title</h2>',
					'  </div>',
					'</div>',
				].join('\n')]]),
			});
			ok(findMatch(result, 'page.html', '.card-header h2'),
				'h2 in b-in should match .card-header h2');
		});
	});

	describe('cross-file partial with slots', () => {
		const componentHtml = [
			'<div b-name="card" b-export>',
			'  <div class="card-header">',
			'    <b-unwrap b-slot="header" />',
			'  </div>',
			'  <div class="card-body">',
			'    <b-unwrap b-slot />',
			'  </div>',
			'</div>',
		].join('\n');

		it('matches b-in content against ancestors inside the cross-file partial', async () => {
			const pageHtml = [
				'<div b-name="page">',
				'  <div b-part="components.html#card">',
				'    <h2 b-in="header">Title</h2>',
				'    <p b-in="default">Body</p>',
				'  </div>',
				'</div>',
			].join('\n');
			const result = await analyze({
				cssContent: '.card-header h2 { color: red; } .card-body p { margin: 0; }',
				templateFiles: new Map([
					['components.html', componentHtml],
					['page.html', pageHtml],
				]),
			});
			ok(findMatch(result, 'page.html', '.card-header h2'),
				'h2 should match .card-header h2 via cross-file slot');
			ok(findMatch(result, 'page.html', '.card-body p'),
				'p should match .card-body p via cross-file default slot');
		});

		it('matches b-in content when b-part is inside a b-name', async () => {
			const pageHtml = [
				'<div b-name="page">',
				'  <div b-part="components.html#card">',
				'    <h2 b-in="header">Title</h2>',
				'  </div>',
				'</div>',
			].join('\n');
			const result = await analyze({
				cssContent: '.card-header h2 { color: red; }',
				templateFiles: new Map([
					['components.html', componentHtml],
					['page.html', pageHtml],
				]),
			});
			ok(findMatch(result, 'page.html', '.card-header h2'),
				'h2 should match .card-header h2 when b-part is inside a b-name');
		});

		it('matches b-in content with ancestors from both caller context and partial internals', async () => {
			const pageHtml = [
				'<div b-name="page">',
				'  <div class="container">',
				'    <div b-part="components.html#card">',
				'      <h2 b-in="header">Title</h2>',
				'    </div>',
				'  </div>',
				'</div>',
			].join('\n');
			const result = await analyze({
				cssContent: '.container .card-header h2 { color: red; }',
				templateFiles: new Map([
					['components.html', componentHtml],
					['page.html', pageHtml],
				]),
			});
			ok(findMatch(result, 'page.html', '.container .card-header h2'),
				'h2 should match selector spanning caller context and partial internals');
		});
	});

	describe('nested cross-file partials with slots', () => {
		it('partial A uses b-part to partial B (cross-file), B has slots', async () => {
			const layoutHtml = [
				'<div b-name="layout" b-export>',
				'  <div class="layout-body">',
				'    <b-unwrap b-slot />',
				'  </div>',
				'</div>',
			].join('\n');
			const pageHtml = [
				'<div b-name="page">',
				'  <div b-part="layout.html#layout">',
				'    <div b-in="default" class="content">',
				'      <h1>Hello</h1>',
				'    </div>',
				'  </div>',
				'</div>',
			].join('\n');
			const result = await analyze({
				cssContent: '.layout-body .content h1 { font-size: 2em; }',
				templateFiles: new Map([
					['layout.html', layoutHtml],
					['page.html', pageHtml],
				]),
			});
			ok(findMatch(result, 'page.html', '.layout-body .content h1'),
				'h1 should match selector where .layout-body is inside the cross-file partial');
		});

		it('slot content in a partial that is itself used from another file', async () => {
			// layout.html defines layout with a slot
			// components.html defines card with a header slot
			// page.html defines page, which uses layout and inside layout's slot uses card
			const layoutHtml = [
				'<div b-name="layout" b-export>',
				'  <div class="layout-body">',
				'    <b-unwrap b-slot />',
				'  </div>',
				'</div>',
			].join('\n');
			const componentHtml = [
				'<div b-name="card" b-export>',
				'  <div class="card-header">',
				'    <b-unwrap b-slot="header" />',
				'  </div>',
				'</div>',
			].join('\n');
			const pageHtml = [
				'<div b-name="page">',
				'  <div b-part="layout.html#layout">',
				'    <div b-in="default">',
				'      <div b-part="components.html#card">',
				'        <span b-in="header">Title</span>',
				'      </div>',
				'    </div>',
				'  </div>',
				'</div>',
			].join('\n');
			const result = await analyze({
				cssContent: '.card-header span { font-weight: bold; }',
				templateFiles: new Map([
					['layout.html', layoutHtml],
					['components.html', componentHtml],
					['page.html', pageHtml],
				]),
			});
			ok(findMatch(result, 'page.html', '.card-header span'),
				'span should match .card-header span through nested cross-file partials');
		});

		it('selector spans layout partial and card partial ancestors', async () => {
			const layoutHtml = [
				'<div b-name="layout" b-export>',
				'  <div class="layout-body">',
				'    <b-unwrap b-slot />',
				'  </div>',
				'</div>',
			].join('\n');
			const componentHtml = [
				'<div b-name="card" b-export>',
				'  <div class="card-header">',
				'    <b-unwrap b-slot="header" />',
				'  </div>',
				'</div>',
			].join('\n');
			const pageHtml = [
				'<div b-name="page">',
				'  <div b-part="layout.html#layout">',
				'    <div b-in="default">',
				'      <div b-part="components.html#card">',
				'        <span b-in="header">Title</span>',
				'      </div>',
				'    </div>',
				'  </div>',
				'</div>',
			].join('\n');
			const result = await analyze({
				cssContent: '.layout-body .card-header span { color: blue; }',
				templateFiles: new Map([
					['layout.html', layoutHtml],
					['components.html', componentHtml],
					['page.html', pageHtml],
				]),
			});
			ok(findMatch(result, 'page.html', '.layout-body .card-header span'),
				'span should match selector spanning both layout and card partial ancestors');
		});
	});

	describe('partialName on slot content should be lexical, not target', () => {
		it('same-file: partialName is the partial containing the b-part usage, not the slot target', async () => {
			const result = await analyze({
				cssContent: '.card-header h2 { color: red; }',
				templateFiles: new Map([['page.html', [
					'<div b-name="card">',
					'  <div class="card-header">',
					'    <b-unwrap b-slot="header" />',
					'  </div>',
					'</div>',
					'<div b-name="page">',
					'  <div b-part="#card">',
					'    <h2 b-in="header">Title</h2>',
					'  </div>',
					'</div>',
				].join('\n')]]),
			});
			const match = findMatch(result, 'page.html', '.card-header h2');
			ok(match, 'h2 should match .card-header h2');
			strictEqual(match!.partialName, 'page',
				'partialName should be "page" (lexical partial), not "card" (slot target)');
		});

		it('cross-file: partialName is the partial containing the b-part usage, not the slot target', async () => {
			const componentHtml = [
				'<div b-name="card" b-export>',
				'  <div class="card-header">',
				'    <b-unwrap b-slot="header" />',
				'  </div>',
				'</div>',
			].join('\n');
			const pageHtml = [
				'<div b-name="page">',
				'  <div b-part="components.html#card">',
				'    <h2 b-in="header">Title</h2>',
				'  </div>',
				'</div>',
			].join('\n');
			const result = await analyze({
				cssContent: '.card-header h2 { color: red; }',
				templateFiles: new Map([
					['components.html', componentHtml],
					['page.html', pageHtml],
				]),
			});
			const match = findMatch(result, 'page.html', '.card-header h2');
			ok(match, 'h2 should match .card-header h2');
			strictEqual(match!.partialName, 'page',
				'partialName should be "page" (lexical partial), not "card" (slot target)');
		});
	});

	describe('cross-file usage with slots, called from the partial root', () => {
		it('matches when the b-part call is a direct child of the calling partial root', async () => {
			const componentHtml = [
				'<div b-name="card" b-export>',
				'  <div class="card-header">',
				'    <b-unwrap b-slot="header" />',
				'  </div>',
				'</div>',
			].join('\n');
			const pageHtml = [
				'<div b-name="page" class="page">',
				'  <div b-part="components.html#card">',
				'    <h2 b-in="header">Title</h2>',
				'  </div>',
				'</div>',
			].join('\n');
			const result = await analyze({
				cssContent: '.card-header h2 { color: red; }',
				templateFiles: new Map([
					['components.html', componentHtml],
					['page.html', pageHtml],
				]),
			});
			ok(findMatch(result, 'page.html', '.card-header h2'),
				'h2 should match through the calling partial root');
		});

		it('matches selector spanning the calling partial root and the target partial', async () => {
			const componentHtml = [
				'<div b-name="card" b-export>',
				'  <div class="card-header">',
				'    <b-unwrap b-slot="header" />',
				'  </div>',
				'</div>',
			].join('\n');
			const pageHtml = [
				'<div b-name="page" class="page">',
				'  <div b-part="components.html#card">',
				'    <h2 b-in="header">Title</h2>',
				'  </div>',
				'</div>',
			].join('\n');
			const result = await analyze({
				cssContent: '.page .card-header h2 { color: red; }',
				templateFiles: new Map([
					['components.html', componentHtml],
					['page.html', pageHtml],
				]),
			});
			ok(findMatch(result, 'page.html', '.page .card-header h2'),
				'h2 should match selector spanning .page (caller) and .card-header (partial)');
		});
	});

	describe('forwarded slots (a partial hands its own slot to a partial it calls)', () => {
		// mid forwards its slot "outer" into child's slot "inner", so at runtime the
		// caller's <h2> renders inside child's .inner, inside child's .child-root.
		const html = [
			'<div b-name="child" class="child-root">',
			'  <div class="inner"><b-unwrap b-slot="inner" /></div>',
			'</div>',
			'<div b-name="mid">',
			'  <div b-part="#child" class="wrap"><b-unwrap b-in="inner" b-slot="outer"></b-unwrap></div>',
			'</div>',
			'<div b-name="page">',
			'  <b-unwrap b-part="#mid"><h2 b-in="outer">Title</h2></b-unwrap>',
			'</div>',
		].join('\n');

		it('matches through the caller-side wrapper of the forwarding call', async () => {
			const result = await analyze({ cssContent: '.wrap h2 { color: red; }', templateFiles: new Map([['t.html', html]]) });
			ok(findMatch(result, 't.html', '.wrap h2'), 'h2 should match .wrap h2');
		});

		it('matches through the forwarded-into partial internals', async () => {
			const result = await analyze({ cssContent: '.inner h2 { color: red; }', templateFiles: new Map([['t.html', html]]) });
			ok(findMatch(result, 't.html', '.inner h2'), 'h2 renders inside .inner, so it should match');
		});

		it('matches through the forwarded-into partial root', async () => {
			const result = await analyze({ cssContent: '.child-root h2 { color: red; }', templateFiles: new Map([['t.html', html]]) });
			ok(findMatch(result, 't.html', '.child-root h2'), 'h2 renders inside .child-root, so it should match');
		});

		it('matches a selector spanning both partials internals', async () => {
			const result = await analyze({ cssContent: '.child-root .inner h2 { color: red; }', templateFiles: new Map([['t.html', html]]) });
			ok(findMatch(result, 't.html', '.child-root .inner h2'),
				'the forwarded-into partial ancestors should be in the right order');
		});
	});
});
