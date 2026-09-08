import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { compileFiles } from '@backflip/html';
import { matchSelectors } from './selector-match.js';
import { buildInstanceForest } from './instance-tree.js';
import { attrIndexOf, tagNameOf } from './tnode-view.js';
import type { CssRule, ElementMatches } from './types.js';

function makeRule(selector: string, props: Record<string, string> = {}, media: string[] = []): CssRule {
	return {
		selectorText: selector,
		selectors: selector.split(',').map(s => s.trim()),
		properties: Object.entries(props).map(([name, value]) => ({ name, value })),
		mediaConditions: media,
		sourceFile: '',
		sourceLine: 1,
		sourceCol: 1,
	};
}

/** Compile `files`, expand them, and match `selectors` (one rule each) over the result. */
async function match(files: Record<string, string>, ...selectors: string[]) {
	const { directory } = await compileFiles(new Map(Object.entries(files)));
	const rules = selectors.map((s, i) => {
		const rule = makeRule(s);
		rule.sourceLine = i + 1;  // keep same-text selectors from deduplicating
		return rule;
	});
	return matchSelectors(rules, buildInstanceForest(directory.files));
}

/** Compile one snippet as the body of a partial with no tag of its own. */
async function matchBody(html: string, ...selectors: string[]) {
	return match({ 't.html': `<b-unwrap b-name="test">${html}</b-unwrap>` }, ...selectors);
}

/** Every `selector=matchType` reported for the element carrying `class="<cls>"`. */
function on(result: Map<string, ElementMatches[]>, cls: string): string[] {
	const out: string[] = [];
	for (const entries of result.values()) {
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
		const entry = result.get('t.html')![0];
		strictEqual(entry.element.type, 'element');
		strictEqual(tagNameOf(entry.element), 'div');
		strictEqual(entry.partialName, 'test');
		strictEqual(entry.startLine, 1);
		strictEqual(entry.startOffset, '<b-unwrap b-name="test">'.length);
	});

	it('reports nothing when no selector applies', async () => {
		const result = await matchBody('<div class="card">hello</div>', '.panel');
		strictEqual(result.size, 0);
	});

	it('sorts a match list by specificity, descending', async () => {
		const result = await matchBody('<div id="main" class="card">x</div>', 'div', '.card', '#main');
		const selectors = result.get('t.html')![0].matches.map(m => m.selector);
		deepStrictEqual(selectors, ['#main', '.card', 'div']);
	});

	it('carries the rule\'s media conditions through', async () => {
		const { directory } = await compileFiles(new Map([
			['t.html', '<div b-name="test" class="card">x</div>'],
		]));
		const rule = makeRule('.card', { color: 'red' }, ['(min-width:768px)']);
		const result = matchSelectors([rule], buildInstanceForest(directory.files));
		deepStrictEqual(result.get('t.html')![0].matches[0].mediaConditions, ['(min-width:768px)']);
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
		strictEqual(result.size, 0);
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
		const fill = result.get('page.html')!.find(e => e.matches.some(m => m.selector === '.card .fill'));
		ok(fill, 'the fill is reported in the file that writes it');
		strictEqual(fill!.partialName, 'page');
		const card = result.get('c.html')![0];
		strictEqual(card.partialName, 'card');
	});
});
