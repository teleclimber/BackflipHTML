import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert';
import { relaxSelector } from './relax-selector.js';
import type { PseudoCategory } from './pseudo-categories.js';

/** `[relaxed, 'stripped, texts, in, order']` — the shape of the spec's prototype table. */
function relaxed(selector: string): [string, string] {
	const result = relaxSelector(selector);
	strictEqual(result.original, selector, 'original is echoed back verbatim');
	return [result.relaxed, result.stripped.map(s => s.text).join(', ')];
}

/** `['name=category', …]` for everything stripped. */
function categories(selector: string): string[] {
	return relaxSelector(selector).stripped.map(s => `${s.name}=${s.category}`);
}

describe('relaxSelector', () => {
	// --- The prototype table from the spec ---

	it('strips a user-action pseudo-class', () => {
		deepStrictEqual(relaxed('.a:hover'), ['.a', ':hover']);
	});

	it('strips a location pseudo-class', () => {
		deepStrictEqual(relaxed('a:visited'), ['a', ':visited']);
	});

	it('strips a pseudo-element', () => {
		deepStrictEqual(relaxed('.a::before'), ['.a', '::before']);
	});

	it('leaves * behind when a compound relaxes away entirely', () => {
		deepStrictEqual(relaxed('.a > ::before'), ['.a > *', '::before']);
	});

	it('drops a functional pseudo whose only alternative empties', () => {
		deepStrictEqual(relaxed('.a:not(:focus)'), ['.a', ':focus, :not']);
	});

	it('keeps a functional pseudo that still has an alternative', () => {
		deepStrictEqual(relaxed('.a:is(:hover, .b)'), ['.a:is(.b)', ':hover']);
	});

	it('strips a pseudo-class and a pseudo-element from one compound', () => {
		deepStrictEqual(relaxed('.a:hover::after'), ['.a', ':hover, ::after']);
	});

	it('strips from the left side of a descendant combinator', () => {
		deepStrictEqual(relaxed('.a:focus-within .b'), ['.a .b', ':focus-within']);
	});

	it('strips across several compounds and combinators', () => {
		deepStrictEqual(relaxed('.wrap > .a:hover + .b::after'), ['.wrap > .a + .b', ':hover, ::after']);
	});

	it('drops :where() when every alternative empties, recording the contents first', () => {
		deepStrictEqual(relaxed('.a:where(:focus, :hover)'), ['.a', ':focus, :hover, :where']);
	});

	it('drops :is() when its only alternative empties', () => {
		deepStrictEqual(relaxed('.a:is(:hover)'), ['.a', ':hover, :is']);
	});

	it('leaves :link alone', () => {
		deepStrictEqual(relaxed('a:link'), ['a:link', '']);
	});

	it('leaves a structural pseudo alone', () => {
		deepStrictEqual(relaxed('.a:nth-child(2n+1)'), ['.a:nth-child(2n+1)', '']);
	});

	// --- Coherence rules ---

	it('relaxes a whole selector away to *', () => {
		deepStrictEqual(relaxed('::selection'), ['*', '::selection']);
	});

	it('returns the original string identically when nothing is stripped', () => {
		const selector = '.a  >  .b:nth-child( 2n + 1 )';
		const result = relaxSelector(selector);
		strictEqual(result.relaxed, selector, 'no stringify round-trip on the untouched path');
		deepStrictEqual(result.stripped, []);
	});

	it('memoizes per selector text', () => {
		strictEqual(relaxSelector('.memo:hover'), relaxSelector('.memo:hover'));
	});

	it('returns the selector untouched when css-what cannot parse it', () => {
		deepStrictEqual(relaxSelector(':::nope'), { original: ':::nope', relaxed: ':::nope', stripped: [] });
	});

	// --- Both spellings of a legacy pseudo-element ---

	it('reports the authored spelling of a single-colon pseudo-element', () => {
		deepStrictEqual(relaxed('.para:before'), ['.para', ':before']);
		deepStrictEqual(categories('.para:before'), ['before=tree-abiding']);
	});

	it('reports the authored spelling of a double-colon pseudo-element', () => {
		deepStrictEqual(relaxed('.para::before'), ['.para', '::before']);
		deepStrictEqual(categories('.para::before'), ['before=tree-abiding']);
	});

	// --- Categories ---

	it('categorizes each stripped pseudo', () => {
		deepStrictEqual(categories('.a:hover'), ['hover=user-action']);
		deepStrictEqual(categories('.a:visited'), ['visited=location']);
		deepStrictEqual(categories('.a:checked'), ['checked=input']);
		deepStrictEqual(categories('.a:dir(rtl)'), ['dir=linguistic']);
		deepStrictEqual(categories('.a:playing'), ['playing=resource-state']);
		deepStrictEqual(categories('.a::selection'), ['selection=highlight']);
		deepStrictEqual(categories('.a::placeholder'), ['placeholder=form-related']);
		deepStrictEqual(categories('.a:contains("x")'), ['contains=not-implemented']);
	});

	it('categorizes a vendor-prefixed pseudo not in the list as non-standard', () => {
		deepStrictEqual(relaxed('.a::-webkit-details-marker'), ['.a', '::-webkit-details-marker']);
		deepStrictEqual(categories('.a::-webkit-details-marker'), ['-webkit-details-marker=non-standard']);
	});

	it('leaves an unlisted, unprefixed pseudo-class for css-select to decide', () => {
		// Not stripped by the list — `relaxSelector` alone keeps it. It is the
		// retry pass in `compileSelector` that turns it into `unknown`.
		deepStrictEqual(relaxed('.a:not-a-real-pseudo'), ['.a:not-a-real-pseudo', '']);
	});

	// --- The pseudos that stay native ---

	it('keeps everything answerable from the template', () => {
		for (const selector of [
			'.a:first-child', '.a:last-child', '.a:only-of-type', '.a:empty', ':root',
			'.a:nth-child(2 of .x)', '.a:has(.b)', '.a:not(.b)', '.a:is(.b, .c)', '.a:where(.b)',
			'.a:scope', 'a:any-link', 'a:link', 'a:lang(en)', '.a:parent', '.a:header', 'input:checkbox',
		]) {
			deepStrictEqual(relaxed(selector), [selector, ''], selector);
		}
	});
});

describe('PSEUDO_CATEGORIES', () => {
	it('has one category per pseudo and no duplicate names', async () => {
		const { PSEUDO_CATEGORIES } = await import('./pseudo-categories.js');
		strictEqual(PSEUDO_CATEGORIES.size, 105);
	});

	it('does not list anything tree-structural or functional', async () => {
		const { PSEUDO_CATEGORIES } = await import('./pseudo-categories.js');
		for (const name of ['first-child', 'nth-child', 'root', 'empty', 'is', 'not', 'where', 'has', 'scope', 'lang', 'link', 'any-link']) {
			strictEqual(PSEUDO_CATEGORIES.has(name), false, `${name} must stay native`);
		}
	});

	it('falls back to unknown for a name it does not carry', async () => {
		const { categoryOf } = await import('./pseudo-categories.js');
		const cases: [string, PseudoCategory][] = [
			['hover', 'user-action'],
			['before', 'tree-abiding'],
			['not-a-real-pseudo', 'unknown'],
			['-webkit-anything-at-all', 'non-standard'],
			['-moz-anything-at-all', 'non-standard'],
			['-ms-anything-at-all', 'non-standard'],
			['-o-anything-at-all', 'non-standard'],
			['-webkit-scrollbar', 'non-standard'],
		];
		for (const [name, category] of cases) strictEqual(categoryOf(name), category, name);
	});
});
