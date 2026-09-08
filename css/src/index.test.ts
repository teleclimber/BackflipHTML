import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { analyzeSource as analyze } from './test-helpers.js';
import { attrIndexOf } from './tnode-view.js';

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

	it('matches a descendant selector across a partial boundary', async () => {
		const result = await analyze({
			cssContent: '.container .inner { color: blue; }',
			templateFiles: new Map([
				['page.html', [
					'<div b-name="page"><div class="container"><div b-part="#card"></div></div></div>',
					'<div b-name="card"><span class="inner">text</span></div>',
				].join('\n')],
			]),
		});

		const matches = result.elementMatches.get('page.html');
		ok(matches, 'should have matches');
		const innerMatch = matches.find(m => m.matches.some(r => r.selector === '.container .inner'));
		ok(innerMatch, 'the span renders inside .container, so .container .inner must match');
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

// ---------------------------------------------------------------------------
// Phase 8: cases the context-spine model gets wrong. Written before the
// instance-model rewrite; see claude-specs/phase-8-css-instance-model.md.
// Selector strings are css-tree's normalized form (`.a>.b`, `.a+.b`).
// ---------------------------------------------------------------------------

type Analysis = Awaited<ReturnType<typeof analyze>>;

/** The match type of `selector` on the element carrying `class="<cls>"`, or undefined. */
function matchType(result: Analysis, file: string, cls: string, selector: string): string | undefined {
	for (const entry of result.elementMatches.get(file) ?? []) {
		const classes = attrIndexOf(entry.element).values.get('class')?.split(/\s+/) ?? [];
		if (!classes.includes(cls)) continue;
		const found = entry.matches.find(m => m.selector === selector);
		if (found) return found.matchType;
	}
	return undefined;
}

describe('render-tree matching across partial, slot and loop boundaries', () => {
	it('matches a class on the tag that carries the b-part call', async () => {
		const result = await analyze({
			cssContent: '.wrap .item { color: red; }',
			templateFiles: new Map([['page.html', [
				'<div b-name="page">',
				'  <div class="wrap" b-part="#card"></div>',
				'</div>',
				'<div b-name="card"><p class="item">x</p></div>',
			].join('\n')]]),
		});
		strictEqual(matchType(result, 'page.html', 'item', '.wrap .item'), 'definite');
	});

	it('matches an adjacent sibling across a slot boundary', async () => {
		const result = await analyze({
			cssContent: '.hd + .body { color: red; }',
			templateFiles: new Map([['page.html', [
				'<div b-name="card">',
				'  <span class="hd">h</span>',
				'  <b-unwrap b-slot />',
				'</div>',
				'<div b-name="page">',
				'  <b-unwrap b-part="#card"><p class="body">b</p></b-unwrap>',
				'</div>',
			].join('\n')]]),
		});
		strictEqual(matchType(result, 'page.html', 'body', '.hd+.body'), 'definite');
	});

	it('resolves :has() into a partial used below the subject', async () => {
		const result = await analyze({
			cssContent: '.wrap:has(.t) { color: red; }',
			templateFiles: new Map([['page.html', [
				'<div b-name="page">',
				'  <div class="wrap"><b-unwrap b-part="#card" /></div>',
				'</div>',
				'<div b-name="card"><p class="t">x</p></div>',
			].join('\n')]]),
		});
		strictEqual(matchType(result, 'page.html', 'wrap', '.wrap:has(.t)'), 'definite');
	});

	it('gives structural pseudos the real child list at a partial boundary', async () => {
		const result = await analyze({
			cssContent: '.wrap > :first-child { color: red; } .wrap > :nth-child(2) { color: blue; }',
			templateFiles: new Map([['page.html', [
				'<div b-name="page">',
				'  <div class="wrap">',
				'    <p class="lead">l</p>',
				'    <div class="slot-wrap" b-part="#card"></div>',
				'  </div>',
				'</div>',
				'<div b-name="card" class="card">c</div>',
			].join('\n')]]),
		});
		strictEqual(matchType(result, 'page.html', 'lead', '.wrap>:first-child'), 'definite');
		strictEqual(matchType(result, 'page.html', 'card', '.wrap>:first-child'), undefined,
			'the partial root renders inside .slot-wrap, so it is no child of .wrap at all');
		strictEqual(matchType(result, 'page.html', 'slot-wrap', '.wrap>:nth-child(2)'), 'definite');
	});

	it('models a b-for body as several iterations', async () => {
		const result = await analyze({
			cssContent: '.item + .item { color: red; } .item:first-child { color: blue; }',
			templateFiles: new Map([['page.html', [
				'<div b-name="page">',
				'  <ul class="list"><li b-for="i in items" class="item">x</li></ul>',
				'</div>',
			].join('\n')]]),
		});
		strictEqual(matchType(result, 'page.html', 'item', '.item+.item'), 'conditional',
			'a looped element follows a copy of itself in all but the first iteration');
		strictEqual(matchType(result, 'page.html', 'item', '.item:first-child'), 'conditional',
			'a looped element is only first in the first iteration');
	});

	it('matches slot content forwarded through two levels of partial', async () => {
		const templateFiles = new Map([['page.html', [
			'<div b-name="inner" class="inner"><b-unwrap b-slot="deep" /></div>',
			'<div b-name="outer" class="outer">',
			'  <b-unwrap b-part="#inner"><b-unwrap b-in="deep" b-slot="fwd" /></b-unwrap>',
			'</div>',
			'<div b-name="page">',
			'  <b-unwrap b-part="#outer"><b class="leaf" b-in="fwd">x</b></b-unwrap>',
			'</div>',
		].join('\n')]]);
		const result = await analyze({ cssContent: '.inner .leaf { color: red; }', templateFiles });
		strictEqual(matchType(result, 'page.html', 'leaf', '.inner .leaf'), 'definite');

		const negative = await analyze({ cssContent: '.nope .leaf { color: red; }', templateFiles });
		strictEqual(matchType(negative, 'page.html', 'leaf', '.nope .leaf'), undefined);
	});
});

describe('analyzeCss failure reporting', () => {
	const page = new Map([
		['page.html', '<div b-name="page"><div class="card"><span class="title">Hi</span></div></div>'],
	]);

	it('reports no failures for clean CSS', async () => {
		const result = await analyze({ cssContent: '.card { color: red; }', templateFiles: page });
		strictEqual(result.failures.length, 0);
	});

	it('keeps matching the rules it could parse', async () => {
		// The bad rule kills everything after it, but .card came first and still
		// matches — a broken stylesheet degrades, it does not abort.
		const result = await analyze({
			cssContent: '.card { color: red }\n.a[ { color: red }\n.title { color: blue }',
			templateFiles: page,
		});

		strictEqual(result.failures.length, 1);
		strictEqual(result.failures[0].reason, 'stylesheet-parse');

		const matches = result.elementMatches.get('page.html');
		ok(matches, 'analysis still ran');
		ok(matches.some(m => m.matches.some(r => r.selector === '.card')), '.card still matched');
	});

	it('reports failures even when nothing parsed at all', async () => {
		// The early return for "no rules" must still carry the reason why.
		const result = await analyze({ cssContent: '.a[ { color: red }', templateFiles: page });
		strictEqual(result.rules.length, 0);
		strictEqual(result.failures.length, 1);
	});

	it('analyzes each stylesheet separately, so one broken file cannot eat the next', async () => {
		const { compileTemplates } = await import('./test-helpers.js');
		const { analyzeCss } = await import('./index.js');
		const result = analyzeCss({
			files: [
				{ path: '/w/broken.css', content: '.card { color: red' },
				{ path: '/w/good.css', content: '.title { color: blue }' },
			],
			compiled: await compileTemplates(page),
		});

		// Concatenating these would have let the unclosed brace swallow .title.
		ok(result.rules.some(r => r.selectorText === '.title'), '.title survived the broken file');
		strictEqual(result.rules.find(r => r.selectorText === '.title')!.sourceFile, '/w/good.css');
		ok(result.failures.every(f => f.sourceFile === '/w/broken.css'), 'failure blamed on the right file');
	});

	it('reports line numbers relative to each file, not a concatenation', async () => {
		const { compileTemplates } = await import('./test-helpers.js');
		const { analyzeCss } = await import('./index.js');
		const result = analyzeCss({
			files: [
				{ path: '/w/a.css', content: '.one { color: red }\n.two { color: red }' },
				{ path: '/w/b.css', content: '.title { color: blue }' },
			],
			compiled: await compileTemplates(page),
		});

		const title = result.rules.find(r => r.selectorText === '.title')!;
		strictEqual(title.sourceFile, '/w/b.css');
		strictEqual(title.sourceLine, 1, 'line 1 of its own file, not line 3 of a join');
	});
});
