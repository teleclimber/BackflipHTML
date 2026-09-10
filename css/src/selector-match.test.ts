import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { compileFiles } from '@backflip/html';
import { matchSelectors, type SelectorMatchResult } from './selector-match.js';
import { buildInstanceForest } from './instance-tree.js';
import { attrIndexOf, tagNameOf } from './tnode-view.js';
import type { CssRule } from './types.js';

function makeRule(selector: string, props: Record<string, string> = {}, media: string[] = [], line = 1): CssRule {
	const selectors = selector.split(',').map(s => s.trim());
	return {
		selectorText: selector,
		selectors,
		// As if the whole list were written on `line`, each selector at the column
		// it occupies in `selector` — enough for a failure to be located.
		selectorLocs: selectors.map(text => {
			const startCol = selector.indexOf(text) + 1;
			return { startLine: line, startCol, endLine: line, endCol: startCol + text.length };
		}),
		properties: Object.entries(props).map(([name, value]) => ({ name, value })),
		mediaConditions: media,
		sourceFile: '',
		sourceLine: line,
		sourceCol: 1,
	};
}

/** Compile `files`, expand them, and match `selectors` (one rule each) over the result. */
async function match(files: Record<string, string>, ...selectors: string[]) {
	const { directory } = await compileFiles(new Map(Object.entries(files)));
	// One rule per line: two rules with the same selector text must not dedupe.
	const rules = selectors.map((s, i) => makeRule(s, {}, [], i + 1));
	return matchSelectors(rules, buildInstanceForest(directory.files));
}

/** Compile one snippet as the body of a partial with no tag of its own. */
async function matchBody(html: string, ...selectors: string[]) {
	return match({ 't.html': `<b-unwrap b-name="test">${html}</b-unwrap>` }, ...selectors);
}

/** Every `selector=matchType` reported for the element carrying `class="<cls>"`. */
function on(result: SelectorMatchResult, cls: string): string[] {
	const out: string[] = [];
	for (const entries of result.elementMatches.values()) {
		for (const entry of entries) {
			const classes = attrIndexOf(entry.element).values.get('class')?.split(/\s+/) ?? [];
			if (!classes.includes(cls)) continue;
			for (const m of entry.matches) out.push(`${m.selector}=${m.matchType}`);
		}
	}
	return out.sort();
}

describe('matchSelectors', () => {
	it('matches by tag, class, id and attribute quoting style', async () => {
		const result = await matchBody(
			`<div class=card id='main' data-x="1">hello</div>`,
			'div', '.card', '#main', '[data-x="1"]',
		);
		deepStrictEqual(on(result, 'card').sort(),
			['#main=definite', '.card=definite', '[data-x="1"]=definite', 'div=definite'].sort());
	});

	it('reports the matched element as the compiler TNode, with its source location', async () => {
		const result = await matchBody('<div class="card">hello</div>', '.card');
		const entry = result.elementMatches.get('t.html')![0];
		strictEqual(entry.element.type, 'element');
		strictEqual(tagNameOf(entry.element), 'div');
		strictEqual(entry.partialName, 'test');
		strictEqual(entry.startLine, 1);
		strictEqual(entry.startOffset, '<b-unwrap b-name="test">'.length);
	});

	it('reports nothing when no selector applies', async () => {
		const result = await matchBody('<div class="card">hello</div>', '.panel');
		strictEqual(result.elementMatches.size, 0);
	});

	it('sorts a match list by specificity, descending', async () => {
		const result = await matchBody('<div id="main" class="card">x</div>', 'div', '.card', '#main');
		const selectors = result.elementMatches.get('t.html')![0].matches.map(m => m.selector);
		deepStrictEqual(selectors, ['#main', '.card', 'div']);
	});

	it('carries the rule\'s media conditions through', async () => {
		const { directory } = await compileFiles(new Map([
			['t.html', '<div b-name="test" class="card">x</div>'],
		]));
		const rule = makeRule('.card', { color: 'red' }, ['(min-width:768px)']);
		const result = matchSelectors([rule], buildInstanceForest(directory.files));
		deepStrictEqual(result.elementMatches.get('t.html')![0].matches[0].mediaConditions, ['(min-width:768px)']);
	});

	// --- Navigation across boundaries: what the adapter buys ---

	it('crosses a partial boundary in both directions', async () => {
		const result = await match({
			'page.html': '<div b-name="page" class="wrap"><b-unwrap b-part="c.html#card" /></div>',
			'c.html': '<div b-name="card" b-export class="card"><span class="t">x</span></div>',
		}, '.wrap .t', '.wrap:has(.t)', '.card .t');
		deepStrictEqual(on(result, 't'), ['.card .t=definite', '.wrap .t=definite']);
		deepStrictEqual(on(result, 'wrap'), ['.wrap:has(.t)=definite']);
	});

	it('sees the tag carrying a b-part as an ancestor of the partial\'s content', async () => {
		const result = await match({
			't.html': [
				'<div b-name="page"><div class="wrap" b-part="#card"></div></div>',
				'<div b-name="card"><p class="item">x</p></div>',
			].join('\n'),
		}, '.wrap .item');
		deepStrictEqual(on(result, 'item'), ['.wrap .item=definite']);
	});

	it('matches sibling combinators across a slot boundary', async () => {
		const result = await match({
			't.html': [
				'<div b-name="card"><span class="hd">h</span><b-unwrap b-slot /></div>',
				'<div b-name="page"><b-unwrap b-part="#card"><p class="body">b</p></b-unwrap></div>',
			].join('\n'),
		}, '.hd + .body', '.hd ~ .body');
		deepStrictEqual(on(result, 'body'), ['.hd + .body=definite', '.hd ~ .body=definite']);
	});

	it('matches :has() with a leading sibling combinator across a slot boundary', async () => {
		// This is the one css-select path that locates an element among its
		// siblings with a raw `indexOf` (`getNextSiblings` in
		// helpers/querying.js), so it only works while instance identity is
		// stable.
		const result = await match({
			't.html': [
				'<div b-name="card"><span class="hd">h</span><b-unwrap b-slot /></div>',
				'<div b-name="page"><b-unwrap b-part="#card"><p class="body">b</p></b-unwrap></div>',
			].join('\n'),
		}, '.hd:has(+ .body)');
		deepStrictEqual(on(result, 'hd'), ['.hd:has(+ .body)=definite']);
	});

	it('does not descend into a <template> for :has(), the way the DOM does not', async () => {
		// css-select skips the children of a `template` tag whenever it walks
		// down (`findAll` / `findOne` in helpers/querying.js), which is what a
		// browser does — template content sits in a separate fragment. Descendant
		// matching runs upwards from the element instead, so it still reports
		// `.wrap .t`, which a browser would not. Nothing here models the fragment.
		const result = await matchBody(
			'<div class="wrap"><template><span class="t">x</span></template></div>',
			'.wrap:has(.t)', '.wrap .t',
		);
		deepStrictEqual(on(result, 'wrap'), []);
		deepStrictEqual(on(result, 't'), ['.wrap .t=definite']);
	});

	it('counts children across a partial boundary for structural pseudos', async () => {
		const result = await match({
			't.html': [
				'<div b-name="page">',
				'  <div class="wrap"><p class="lead">l</p><div class="host" b-part="#card"></div></div>',
				'</div>',
				'<div b-name="card" class="card">c</div>',
			].join('\n'),
		}, '.wrap > :first-child', '.wrap > :nth-child(2)', '.wrap > :last-child');
		deepStrictEqual(on(result, 'lead'), ['.wrap > :first-child=definite']);
		deepStrictEqual(on(result, 'host'),
			['.wrap > :last-child=definite', '.wrap > :nth-child(2)=definite']);
		deepStrictEqual(on(result, 'card'), [], 'the partial root is a child of .host, not of .wrap');
	});

	// --- Match types ---

	it('reports a b-for element definite for a plain selector, conditional for a positional one', async () => {
		const result = await matchBody(
			'<ul class="list"><li b-for="i in items" class="item">x</li></ul>',
			'.item', '.item:first-child', '.item + .item',
		);
		deepStrictEqual(on(result, 'item'),
			['.item + .item=conditional', '.item:first-child=conditional', '.item=definite']);
	});

	it('reports an element that matches in only some uses of its partial as conditional', async () => {
		const result = await match({
			't.html': [
				'<div b-name="page">',
				'  <div class="wrap"><b-unwrap b-part="#card" /></div>',
				'  <div class="other"><b-unwrap b-part="#card" /></div>',
				'</div>',
				'<div b-name="card"><p class="item">x</p></div>',
			].join('\n'),
		}, '.wrap .item', '.item');
		deepStrictEqual(on(result, 'item'), ['.item=definite', '.wrap .item=conditional']);
	});

	it('marks the tag carrying b-if conditional but not its contents', async () => {
		const result = await matchBody(
			'<div b-if="show" class="banner"><span class="inner">x</span></div>',
			'.banner', '.inner',
		);
		deepStrictEqual(on(result, 'banner'), ['.banner=conditional']);
		deepStrictEqual(on(result, 'inner'), ['.inner=definite']);
	});

	it('matches every b-if branch', async () => {
		const result = await matchBody(
			'<div b-if="show" class="banner">a</div><div b-else class="fallback">b</div>',
			'.banner', '.fallback',
		);
		deepStrictEqual(on(result, 'banner'), ['.banner=conditional']);
		deepStrictEqual(on(result, 'fallback'), ['.fallback=conditional']);
	});

	it('reports a statically matched element as dynamic when it also binds :class', async () => {
		const result = await matchBody('<div class="btn" :class="expr">x</div>', '.btn', 'div');
		deepStrictEqual(on(result, 'btn'), ['.btn=dynamic', 'div=definite']);
	});

	it('cannot predict the value of a bound class', async () => {
		const result = await matchBody('<div :class="expr">x</div>', '.active');
		strictEqual(result.elementMatches.size, 0);
	});

	// --- Custom elements ---

	it('matches a custom-element call site as one tag carrying both sides\' attrs', async () => {
		const result = await match({
			'page.html': '<div b-name="page"><my-card class="call"><span class="inside">x</span></my-card></div>',
			'c.html': '<my-card b-export data-role="card"><div class="ce-body"><b-unwrap b-slot /></div></my-card>',
		}, 'my-card.call', 'my-card[data-role="card"]', '.call .inside', '.ce-body .inside');
		deepStrictEqual(on(result, 'call'),
			['my-card.call=definite', 'my-card[data-role="card"]=definite']);
		deepStrictEqual(on(result, 'inside'), ['.call .inside=definite', '.ce-body .inside=definite']);
	});

	it('skips an invalid selector instead of failing the run', async () => {
		const result = await matchBody('<div class="card">x</div>', '.card', ':::nope');
		deepStrictEqual(on(result, 'card'), ['.card=definite']);
	});

	it('attributes each match to the file and partial the element is written in', async () => {
		const result = await match({
			'page.html': '<div b-name="page"><b-unwrap b-part="c.html#card"><p class="fill">x</p></b-unwrap></div>',
			'c.html': '<div b-name="card" b-export class="card"><b-unwrap b-slot /></div>',
		}, '.card .fill', '.card');
		const fill = result.elementMatches.get('page.html')!.find(e => e.matches.some(m => m.selector === '.card .fill'));
		ok(fill, 'the fill is reported in the file that writes it');
		strictEqual(fill!.partialName, 'page');
		const card = result.elementMatches.get('c.html')![0];
		strictEqual(card.partialName, 'card');
	});
});

// --- Pseudo relaxation (Phase 9) ---

/** The template the relaxation table runs against. */
const PSEUDO_HTML = [
	'<div class="page">',
	'  <a class="link" href="/x">x</a>',
	'  <input class="field" type="checkbox">',
	'  <label class="lbl">l</label>',
	'  <p class="para">text</p>',
	'</div>',
].join('\n');

/** Match one selector over `PSEUDO_HTML` and report the `MatchedRule` on `cls`, if any. */
async function pseudoMatch(selector: string, cls: string) {
	const result = await matchBody(PSEUDO_HTML, selector);
	for (const entries of result.elementMatches.values()) {
		for (const entry of entries) {
			const classes = attrIndexOf(entry.element).values.get('class')?.split(/\s+/) ?? [];
			if (!classes.includes(cls)) continue;
			const hit = entry.matches.find(m => m.selector === selector);
			if (hit) return hit;
		}
	}
	return undefined;
}

describe('matchSelectors with pseudo relaxation', () => {
	// The "Today's behavior" table from the spec: every row must now report the
	// element it targets. The four structural/link rows already passed and are
	// regression controls — `:link` in particular only works because `:visited`
	// stays a dead branch inside css-select's alias expansion.
	const table: [selector: string, targets: string][] = [
		['.link:first-child', 'link'],
		['.para:last-child', 'para'],
		['.link:any-link', 'link'],
		['.link:link', 'link'],
		['.link:hover', 'link'],
		['.link:visited', 'link'],
		['.link:focus', 'link'],
		['.para::before', 'para'],
		['.para:before', 'para'],
		['.field:checked + .lbl', 'lbl'],
		['.field:disabled', 'field'],
		['.para:contains("text")', 'para'],
		['.page > ::selection', 'para'],
	];

	for (const [selector, cls] of table) {
		it(`reports ${selector} on .${cls}`, async () => {
			ok(await pseudoMatch(selector, cls), `${selector} should target .${cls}`);
		});
	}

	it('carries the stripped pseudos, their authored text and their categories', async () => {
		const hover = await pseudoMatch('.link:hover', 'link');
		deepStrictEqual(hover!.strippedPseudos,
			[{ text: ':hover', name: 'hover', category: 'user-action' }]);

		const checked = await pseudoMatch('.field:checked + .lbl', 'lbl');
		deepStrictEqual(checked!.strippedPseudos,
			[{ text: ':checked', name: 'checked', category: 'input' }]);
	});

	it('reports both spellings of a legacy pseudo-element as authored', async () => {
		const double = await pseudoMatch('.para::before', 'para');
		deepStrictEqual(double!.strippedPseudos,
			[{ text: '::before', name: 'before', category: 'tree-abiding' }]);

		const single = await pseudoMatch('.para:before', 'para');
		deepStrictEqual(single!.strippedPseudos,
			[{ text: ':before', name: 'before', category: 'tree-abiding' }]);
	});

	it('leaves strippedPseudos empty for a selector that needed no relaxation', async () => {
		const control = await pseudoMatch('.link:first-child', 'link');
		deepStrictEqual(control!.strippedPseudos, []);
	});

	it('reports the authored selector and its specificity, not the relaxed form', async () => {
		const hover = await pseudoMatch('.link:hover', 'link');
		strictEqual(hover!.selector, '.link:hover');
		deepStrictEqual(hover!.specificity, [0, 2, 0]);

		const before = await pseudoMatch('.para::before', 'para');
		strictEqual(before!.selector, '.para::before');
		deepStrictEqual(before!.specificity, [0, 1, 1]);
	});

	it('reports a selector that relaxes away entirely against every element', async () => {
		const result = await matchBody(PSEUDO_HTML, '::selection');
		for (const cls of ['page', 'link', 'field', 'lbl', 'para']) {
			deepStrictEqual(on(result, cls), ['::selection=definite'], cls);
		}
	});

	it('reports a vendor-prefixed pseudo the list does not carry as non-standard', async () => {
		const hit = await pseudoMatch('.para::-webkit-details-marker', 'para');
		deepStrictEqual(hit!.strippedPseudos,
			[{ text: '::-webkit-details-marker', name: '-webkit-details-marker', category: 'non-standard' }]);
	});
});

// --- Selectors that will not compile even relaxed ---

describe('matchSelectors selector failures', () => {
	it('reports no failure when every selector compiles', async () => {
		const result = await matchBody(PSEUDO_HTML, '.para', '.link:hover');
		deepStrictEqual(result.failures, []);
	});

	it('reports a selector css-select refuses, and matches nothing for it', async () => {
		const result = await matchBody(PSEUDO_HTML, '.para', ':::nope');
		deepStrictEqual(on(result, 'para'), ['.para=definite'], 'the other selector is unaffected');
		strictEqual(result.failures.length, 1);
		strictEqual(result.failures[0].reason, 'selector-parse');
		ok(result.failures[0].message.includes(':::nope'), result.failures[0].message);
	});

	it('reports an unlisted pseudo-class rather than guessing at it', async () => {
		// Relaxation leaves an unlisted name alone, so css-select decides — and
		// it refuses. A pseudo nobody has categorized is authored CSS Backflip
		// cannot read, not something to strip on spec.
		const result = await matchBody(PSEUDO_HTML, '.para:brand-new-pseudo');
		deepStrictEqual(on(result, 'para'), []);
		strictEqual(result.failures.length, 1);
		ok(result.failures[0].message.includes(':brand-new-pseudo'), result.failures[0].message);
	});

	it('reports a supported name with an argument css-select refuses', async () => {
		// `:nth-child` is not on the strip list, so relaxation leaves the
		// argument alone and css-select throws on `svg|circle`.
		const result = await matchBody(PSEUDO_HTML, '.para:nth-child(2 of svg|circle)');
		deepStrictEqual(on(result, 'para'), []);
		strictEqual(result.failures.length, 1);
	});

	it('locates the failure on the selector, in the file the rule came from', async () => {
		const { directory } = await compileFiles(new Map([['t.html', '<div b-name="test" class="card"></div>']]));
		const rule = makeRule('.card, .card:::nope', {}, [], 7);
		rule.sourceFile = '/w/styles.css';
		const result = matchSelectors([rule], buildInstanceForest(directory.files));

		strictEqual(result.failures.length, 1, 'only the selector that failed is reported');
		const [failure] = result.failures;
		strictEqual(failure.sourceFile, '/w/styles.css');
		strictEqual(failure.sourceLine, 7);
		strictEqual(failure.sourceCol, 8);      // past `.card, `
		strictEqual(failure.lostStartLine, 7);
		strictEqual(failure.lostStartCol, 8);
		strictEqual(failure.lostEndLine, 7);
		strictEqual(failure.lostEndCol, 8 + '.card:::nope'.length);
	});

	it('reports one failure per occurrence, so every rule gets its own squiggle', async () => {
		const result = await matchBody(PSEUDO_HTML, ':::nope', ':::nope');
		strictEqual(result.failures.length, 2);
		deepStrictEqual(result.failures.map(f => f.sourceLine), [1, 2]);
	});

	it('collapses a bad selector repeated inside one rule to a single failure', async () => {
		const { directory } = await compileFiles(new Map([['t.html', '<div b-name="test" class="card"></div>']]));
		const result = matchSelectors([makeRule(':::nope, :::nope')], buildInstanceForest(directory.files));
		strictEqual(result.failures.length, 1);
	});

	it('falls back to the rule position when a selector has no location', async () => {
		const { directory } = await compileFiles(new Map([['t.html', '<div b-name="test" class="card"></div>']]));
		const rule = makeRule(':::nope', {}, [], 4);
		rule.selectorLocs = [];
		const result = matchSelectors([rule], buildInstanceForest(directory.files));

		const [failure] = result.failures;
		strictEqual(failure.sourceLine, 4);
		strictEqual(failure.sourceCol, 1);
		strictEqual(failure.lostStartLine, 4);
		strictEqual(failure.lostEndLine, 4);
	});
});
