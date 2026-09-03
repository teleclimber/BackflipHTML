import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { analyzeSource as analyze } from './test-helpers.js';

describe('analyzeCss', () => {
	it('matches CSS rules to template elements', async () => {
		const result = await analyze({
			cssContent: '.card { color: red; } .title { font-size: 16px; }',
			templateFiles: new Map([
				['page.html', '<div b-name="page"><div class="card"><span class="title">Hello</span></div></div>'],
			]),
		});

		strictEqual(result.rules.length, 2);
		const matches = result.elementMatches.get('page.html');
		ok(matches, 'should have matches for page.html');
		// Should match .card on the div and .title on the span
		const cardMatch = matches.find(m => m.matches.some(r => r.selector === '.card'));
		ok(cardMatch, 'should match .card');
		const titleMatch = matches.find(m => m.matches.some(r => r.selector === '.title'));
		ok(titleMatch, 'should match .title');
	});

	it('matches descendant selectors using context spines', async () => {
		const result = await analyze({
			cssContent: '.container .inner { color: blue; }',
			templateFiles: new Map([
				['page.html', '<div class="container"><div b-part="card"></div></div><div b-name="card"><span class="inner">text</span></div>'],
			]),
		});

		const matches = result.elementMatches.get('page.html');
		ok(matches, 'should have matches');
		const innerMatch = matches.find(m => m.matches.some(r => r.selector === '.container .inner'));
		ok(innerMatch, 'should match .container .inner via context spine');
	});

	it('analyzes the body of a custom-element partial, and the call site as a tag', async () => {
		const result = await analyze({
			cssContent: '.ce-inner { color: red; } my-card.call { color: blue; }',
			templateFiles: new Map([
				['page.html', '<div b-name="page"><my-card class="call">x</my-card></div>'],
				['card.html', '<my-card b-export><div class="ce-inner"><b-unwrap b-slot /></div></my-card>'],
			]),
		});

		const inDefinition = result.elementMatches.get('card.html');
		ok(inDefinition, 'the custom-element partial body is analyzed');
		ok(inDefinition.some(m => m.matches.some(r => r.selector === '.ce-inner')));
		const atCallSite = result.elementMatches.get('page.html');
		ok(atCallSite, 'the call site is analyzed');
		ok(atCallSite.some(m => m.matches.some(r => r.selector === 'my-card.call')),
			'the call site matches by tag name and its own attrs');
	});

	it('returns empty results for empty CSS', async () => {
		const result = await analyze({
			cssContent: '',
			templateFiles: new Map([
				['page.html', '<div b-name="page"><div class="card">hi</div></div>'],
			]),
		});
		strictEqual(result.rules.length, 0);
		strictEqual(result.elementMatches.size, 0);
	});

	it('returns empty results for templates with no partials', async () => {
		const result = await analyze({
			cssContent: '.card { color: red; }',
			templateFiles: new Map([
				['page.html', '<div class="card">hi</div>'],
			]),
		});
		// No partials defined, so no elements to match against
		strictEqual(result.elementMatches.size, 0);
	});

	it('preserves media conditions in matches', async () => {
		const result = await analyze({
			cssContent: '@media print { .card { color: black; } }',
			templateFiles: new Map([
				['page.html', '<div b-name="page"><div class="card">hi</div></div>'],
			]),
		});

		const matches = result.elementMatches.get('page.html');
		ok(matches);
		const cardMatch = matches.find(m => m.matches.some(r => r.selector === '.card'));
		ok(cardMatch);
		ok(cardMatch.matches[0].mediaConditions.length > 0);
	});

	it('handles multiple template files', async () => {
		const result = await analyze({
			cssContent: '.card { color: red; } .panel { color: blue; }',
			templateFiles: new Map([
				['components.html', '<div b-name="card" b-export><div class="card">content</div></div>'],
				['page.html', '<div b-name="page"><div class="panel"><div b-part="components.html#card"></div></div></div>'],
			]),
		});

		// card partial should have .card matched
		const compMatches = result.elementMatches.get('components.html');
		ok(compMatches, 'should have matches for components.html');
		ok(compMatches.some(m => m.matches.some(r => r.selector === '.card')));
	});

	it('matches slot content (b-in) against ancestors inside the partial definition', async () => {
		const result = await analyze({
			cssContent: '.card-header h2 { color: red; }',
			templateFiles: new Map([
				['page.html', [
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
				].join('\n')],
			]),
		});

		const matches = result.elementMatches.get('page.html');
		ok(matches, 'should have matches for page.html');
		const h2Match = matches.find(m =>
			m.matches.some(r => r.selector === '.card-header h2')
		);
		ok(h2Match, 'h2 in b-in should match .card-header h2 via slot spine');
	});

	it('matches selectors anchored on the enclosing partial root element', async () => {
		const result = await analyze({
			cssContent: '.page .t { color: red; } .page .card { color: blue; }',
			templateFiles: new Map([
				['page.html', [
					'<div b-name="page" class="page">',
					'  <div class="mid"><div b-part="#card"></div></div>',
					'</div>',
					'<div b-name="card" class="card"><span class="t">x</span></div>',
				].join('\n')],
			]),
		});

		const matches = result.elementMatches.get('page.html');
		ok(matches, 'should have matches');
		ok(
			matches.some(m => m.matches.some(r => r.selector === '.page .t')),
			'span.t is rendered inside div.page, so .page .t must match',
		);
		ok(
			matches.some(m => m.matches.some(r => r.selector === '.page .card')),
			'the card root is rendered inside div.page, so .page .card must match',
		);
	});

	it('matches slot content against ancestors outside the partial (caller context)', async () => {
		const result = await analyze({
			cssContent: '.page-wrapper .card-body p { margin: 0; }',
			templateFiles: new Map([
				['page.html', [
					'<div b-name="card">',
					'  <div class="card-body">',
					'    <b-unwrap b-slot />',
					'  </div>',
					'</div>',
					'<div b-name="page">',
					'  <div class="page-wrapper">',
					'    <div b-part="#card">',
					'      <p b-in="default">Content</p>',
					'    </div>',
					'  </div>',
					'</div>',
				].join('\n')],
			]),
		});

		const matches = result.elementMatches.get('page.html');
		ok(matches, 'should have matches');
		const pMatch = matches.find(m =>
			m.matches.some(r => r.selector === '.page-wrapper .card-body p')
		);
		ok(pMatch, 'p in b-in should match via combined caller + partial-internal spine');
	});

	it('matches slot content in cross-file partials', async () => {
		const result = await analyze({
			cssContent: '.card-header span { font-weight: bold; }',
			templateFiles: new Map([
				['components.html', [
					'<div b-name="card" b-export>',
					'  <div class="card-header">',
					'    <b-unwrap b-slot="header" />',
					'  </div>',
					'</div>',
				].join('\n')],
				['page.html', [
					'<div b-name="page">',
					'  <div b-part="components.html#card">',
					'    <span b-in="header">Title</span>',
					'  </div>',
					'</div>',
				].join('\n')],
			]),
		});

		const matches = result.elementMatches.get('page.html');
		ok(matches, 'should have matches for page.html');
		const spanMatch = matches.find(m =>
			m.matches.some(r => r.selector === '.card-header span')
		);
		ok(spanMatch, 'span in b-in should match .card-header span from cross-file partial');
	});

	it('sorts matches by specificity', async () => {
		const result = await analyze({
			cssContent: 'div { margin: 0; } .card { color: red; } #main { font-size: 16px; }',
			templateFiles: new Map([
				['page.html', '<div b-name="page"><div id="main" class="card">hi</div></div>'],
			]),
		});

		const matches = result.elementMatches.get('page.html');
		ok(matches);
		// Find the element that has all 3 matches
		const el = matches.find(m => m.matches.length === 3);
		ok(el, 'should have element with 3 matches');
		strictEqual(el.matches[0].selector, '#main');  // highest specificity
		strictEqual(el.matches[1].selector, '.card');
		strictEqual(el.matches[2].selector, 'div');    // lowest specificity
	});
});
