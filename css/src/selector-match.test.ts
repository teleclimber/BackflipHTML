import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { compileFiles } from '@backflip/html';
import { matchSelectors, type MatchRoots } from './selector-match.js';
import { tagNameOf } from './tnode-view.js';
import type { CssRule, ContextSpine, SpineNode } from './types.js';

function makeRule(selector: string, props: Record<string, string> = {}, media: string[] = []): CssRule {
	return {
		selectorText: selector,
		selectors: selector.split(',').map(s => s.trim()),
		properties: Object.entries(props).map(([name, value]) => ({ name, value })),
		mediaConditions: media,
		sourceLine: 1,
		sourceCol: 1,
	};
}

/**
 * Compile `html` as the body of a partial and return it as match roots. The
 * partial is wrapped in `<b-unwrap b-name>` so the snippet's own top-level
 * elements are the roots, with no wrapper element of their own.
 */
async function setupPartial(html: string, partialName = 'test'): Promise<Map<string, MatchRoots>> {
	const source = `<b-unwrap b-name="${partialName}">${html}</b-unwrap>`;
	const { directory, errors } = await compileFiles(new Map([['test.html', source]]));
	if (errors.length > 0) throw new Error(`compile failed: ${errors.map(e => e.message).join('; ')}`);
	const root = directory.files.get('test.html')!.partials.get(partialName)!;
	return new Map([[partialName, { roots: root.tnodes, file: 'test.html', partialName }]]);
}

/** Compile several files, returning match roots for one named partial of one of them. */
async function setupFiles(
	files: Record<string, string>,
	file: string,
	partialName: string,
): Promise<Map<string, MatchRoots>> {
	const { directory, errors } = await compileFiles(new Map(Object.entries(files)));
	if (errors.length > 0) throw new Error(`compile failed: ${errors.map(e => e.message).join('; ')}`);
	const root = directory.files.get(file)!.partials.get(partialName)!;
	return new Map([[partialName, { roots: root.tnodes, file, partialName }]]);
}

function spineNode(tagName: string, attrs: { name: string; value: string }[] = [], opts: Partial<SpineNode> = {}): SpineNode {
	return {
		tagName,
		attrs,
		dynamicAttrs: [],
		isConditional: false,
		children: [],
		parent: null,
		sourceFile: 'test.html',
		sourceElement: null,
		...opts,
	};
}

function spines(...list: ContextSpine[]): Map<string, ContextSpine[]> {
	return new Map([['test', list]]);
}

function emptySpines(): Map<string, ContextSpine[]> {
	return new Map();
}

describe('matchSelectors', () => {
	it('matches a tag selector', async () => {
		const partials = await setupPartial('<div>hello</div>');
		const rules = [makeRule('div')];
		const result = matchSelectors(rules, partials, emptySpines());
		const matches = result.get('test.html');
		ok(matches);
		strictEqual(matches.length, 1);
		strictEqual(matches[0].matches[0].selector, 'div');
	});

	it('matches a class selector', async () => {
		const partials = await setupPartial('<div class="card">hello</div>');
		const rules = [makeRule('.card')];
		const result = matchSelectors(rules, partials, emptySpines());
		const matches = result.get('test.html')!;
		strictEqual(matches.length, 1);
		strictEqual(matches[0].matches[0].selector, '.card');
	});

	it('does not match when selector does not apply', async () => {
		const partials = await setupPartial('<div class="card">hello</div>');
		const rules = [makeRule('.panel')];
		const result = matchSelectors(rules, partials, emptySpines());
		const matches = result.get('test.html');
		strictEqual(matches, undefined);
	});

	it('reports the matched element as the compiler TNode, with its source location', async () => {
		const partials = await setupPartial('<div class="card">hello</div>');
		const result = matchSelectors([makeRule('.card')], partials, emptySpines());
		const entry = result.get('test.html')![0];
		strictEqual(entry.element.type, 'element');
		strictEqual(tagNameOf(entry.element), 'div');
		strictEqual(entry.startLine, 1);
		// The open tag starts right after `<b-unwrap b-name="test">`.
		strictEqual(entry.startOffset, '<b-unwrap b-name="test">'.length);
	});

	it('matches unquoted and single-quoted attribute values', async () => {
		const partials = await setupPartial(`<div class=card id='main'>hello</div>`);
		const result = matchSelectors([makeRule('.card'), makeRule('#main')], partials, emptySpines());
		const sels = result.get('test.html')![0].matches.map(m => m.selector);
		ok(sels.includes('.card'));
		ok(sels.includes('#main'));
	});

	it('matches descendant selector with spine ancestors', async () => {
		const partials = await setupPartial('<span class="title">text</span>');
		const rules = [makeRule('.card .title')];
		const result = matchSelectors(rules, partials, spines({
			ancestors: [spineNode('div', [{ name: 'class', value: 'card' }])],
			isConditional: false,
		}));
		const matches = result.get('test.html')!;
		strictEqual(matches.length, 1);
		strictEqual(matches[0].matches[0].selector, '.card .title');
	});

	it('does not match descendant selector without matching ancestor', async () => {
		const partials = await setupPartial('<span class="title">text</span>');
		const rules = [makeRule('.card .title')];
		const result = matchSelectors(rules, partials, spines({
			ancestors: [spineNode('div', [{ name: 'class', value: 'panel' }])],
			isConditional: false,
		}));
		strictEqual(result.get('test.html'), undefined);
	});

	it('matches child combinator', async () => {
		const partials = await setupPartial('<div class="card"><span class="title">text</span></div>');
		const rules = [makeRule('.card > .title')];
		const result = matchSelectors(rules, partials, emptySpines());
		const matches = result.get('test.html')!;
		ok(matches.some(m => m.matches.some(r => r.selector === '.card > .title')));
	});

	it('marks dynamic match type for elements with b-bind:class', async () => {
		const partials = await setupPartial('<div :class="expr">text</div>');
		const rules = [makeRule('.active')];
		const result = matchSelectors(rules, partials, emptySpines());
		// Dynamic class means we can't definitively say it matches or doesn't
		// The element doesn't have class="active" statically, so it won't match
		strictEqual(result.get('test.html'), undefined);
	});

	it('marks a static match dynamic when the same element also binds :class', async () => {
		const partials = await setupPartial('<div class="btn" :class="expr">text</div>');
		const result = matchSelectors([makeRule('.btn')], partials, emptySpines());
		strictEqual(result.get('test.html')![0].matches[0].matchType, 'dynamic');
	});

	it('marks conditional match type when spine is conditional', async () => {
		const partials = await setupPartial('<span>text</span>');
		const rules = [makeRule('span')];
		const result = matchSelectors(rules, partials, spines({
			ancestors: [spineNode('div', [], { isConditional: true })],
			isConditional: true,
		}));
		const matches = result.get('test.html')!;
		strictEqual(matches[0].matches[0].matchType, 'conditional');
	});

	it('marks the tag carrying b-if conditional, but not its contents', async () => {
		const partials = await setupPartial(
			'<div b-if="show" class="banner"><span class="inner">x</span></div>',
		);
		const result = matchSelectors([makeRule('.banner'), makeRule('.inner')], partials, emptySpines());
		const matches = result.get('test.html')!;
		const banner = matches.find(m => m.matches.some(r => r.selector === '.banner'))!;
		const inner = matches.find(m => m.matches.some(r => r.selector === '.inner'))!;
		strictEqual(banner.matches[0].matchType, 'conditional');
		strictEqual(inner.matches[0].matchType, 'definite');
	});

	it('matches elements in every b-if branch', async () => {
		const partials = await setupPartial([
			'<div b-if="show" class="banner">a</div>',
			'<div b-else class="fallback">b</div>',
		].join(''));
		const result = matchSelectors([makeRule('.banner'), makeRule('.fallback')], partials, emptySpines());
		const matches = result.get('test.html')!;
		strictEqual(matches.length, 2);
		for (const entry of matches) strictEqual(entry.matches[0].matchType, 'conditional');
	});

	it('matches elements inside a b-for body', async () => {
		const partials = await setupPartial('<ul class="list"><li b-for="i in items" class="item">x</li></ul>');
		const result = matchSelectors([makeRule('.list > .item')], partials, emptySpines());
		const matches = result.get('test.html')!;
		ok(matches.some(m => m.matches.some(r => r.selector === '.list > .item')));
	});

	it('sorts matches by specificity descending', async () => {
		const partials = await setupPartial('<div id="main" class="card">text</div>');
		const rules = [
			makeRule('div', {}, []),
			makeRule('.card', {}, []),
			makeRule('#main', {}, []),
		];
		// Give each rule a unique source location
		rules[0].sourceLine = 1;
		rules[1].sourceLine = 2;
		rules[2].sourceLine = 3;
		const result = matchSelectors(rules, partials, emptySpines());
		const matches = result.get('test.html')!;
		const sels = matches[0].matches.map(m => m.selector);
		strictEqual(sels[0], '#main');  // highest specificity
		strictEqual(sels[1], '.card');
		strictEqual(sels[2], 'div');    // lowest specificity
	});

	it('preserves media conditions from rules', async () => {
		const partials = await setupPartial('<div class="card">text</div>');
		const rules = [makeRule('.card', { color: 'red' }, ['(min-width:768px)'])];
		const result = matchSelectors(rules, partials, emptySpines());
		const matches = result.get('test.html')!;
		deepStrictEqual(matches[0].matches[0].mediaConditions, ['(min-width:768px)']);
	});

	it('matches across multiple spines (union)', async () => {
		const partials = await setupPartial('<span class="title">text</span>');
		const rules = [makeRule('.card .title'), makeRule('.panel .title')];
		rules[0].sourceLine = 1;
		rules[1].sourceLine = 2;
		const result = matchSelectors(rules, partials, spines(
			{ ancestors: [spineNode('div', [{ name: 'class', value: 'card' }])], isConditional: false },
			{ ancestors: [spineNode('div', [{ name: 'class', value: 'panel' }])], isConditional: false },
		));
		const matches = result.get('test.html')!;
		const sels = matches[0].matches.map(m => m.selector);
		ok(sels.includes('.card .title'));
		ok(sels.includes('.panel .title'));
	});

	it('keeps each spine independent: a deep selector matched under one spine is not carried into another', async () => {
		const partials = await setupPartial('<div class="outer"><span class="title">text</span></div>');
		const result = matchSelectors([makeRule('.card .outer .title')], partials, spines(
			{ ancestors: [spineNode('div', [{ name: 'class', value: 'card' }])], isConditional: false },
			{ ancestors: [spineNode('div', [{ name: 'class', value: 'panel' }])], isConditional: false },
		));
		// Matches under the .card spine only, but it must match at all: css-select's
		// per-selector ancestor cache must not persist a "no" from the other spine.
		const matches = result.get('test.html')!;
		ok(matches.some(m => m.matches.some(r => r.selector === '.card .outer .title')));
	});

	it('matches nested elements', async () => {
		const partials = await setupPartial('<div class="card"><p><span>text</span></p></div>');
		const rules = [makeRule('.card span')];
		const result = matchSelectors(rules, partials, emptySpines());
		const matches = result.get('test.html')!;
		ok(matches.some(m => m.matches.some(r => r.selector === '.card span')));
	});

	it('matches sibling combinators within one subtree', async () => {
		const partials = await setupPartial(
			'<div class="row"><p class="a">1</p><p class="b">2</p></div>',
		);
		const result = matchSelectors([makeRule('.a + .b'), makeRule('.a ~ .b')], partials, emptySpines());
		const matches = result.get('test.html')!;
		const sels = matches.flatMap(m => m.matches.map(r => r.selector));
		ok(sels.includes('.a + .b'), 'adjacent sibling should match');
		ok(sels.includes('.a ~ .b'), 'general sibling should match');
	});

	it('sees b-part slot content under the tag that carries the call', async () => {
		const partials = await setupFiles({
			'test.html': [
				'<div b-name="test">',
				'  <div class="host" b-part="#card">',
				'    <h2 b-in="header" class="fill">Title</h2>',
				'  </div>',
				'</div>',
				'<div b-name="card"><b-unwrap b-slot="header" /></div>',
			].join('\n'),
		}, 'test.html', 'test');
		const result = matchSelectors([makeRule('.host > .fill')], partials, emptySpines());
		const matches = result.get('test.html')!;
		ok(matches.some(m => m.matches.some(r => r.selector === '.host > .fill')),
			"slot content is a child of the carrying tag in the caller's own tree");
	});

	it('matches a custom-element call site as a tag with its call-site attrs', async () => {
		const partials = await setupFiles({
			'test.html': [
				'<div b-name="test">',
				'  <my-card class="call"><span class="inside">x</span></my-card>',
				'</div>',
				'<my-card b-export><div class="ce-body"><b-unwrap b-slot /></div></my-card>',
			].join('\n'),
		}, 'test.html', 'test');
		const result = matchSelectors(
			[makeRule('my-card.call'), makeRule('.call > .inside')], partials, emptySpines(),
		);
		const matches = result.get('test.html')!;
		const sels = matches.flatMap(m => m.matches.map(r => r.selector));
		ok(sels.includes('my-card.call'), 'the call site matches by tag name and call-site class');
		ok(sels.includes('.call > .inside'), 'its slot content are its children');
	});
});
