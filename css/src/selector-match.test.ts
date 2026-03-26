import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { matchSelectors, matchNodeFromElement, type MatchNode } from './selector-match.js';
import { parseTemplate } from './parse-dom.js';
import type { CssRule, ContextSpine } from './types.js';

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

function setupPartial(html: string, partialName: string = 'test') {
	const tmpl = parseTemplate(html, 'test.html');
	// Build MatchNode trees from top-level elements only (children are included recursively)
	const roots: MatchNode[] = [];
	for (const child of tmpl.fragment.childNodes) {
		if ('tagName' in child) {
			roots.push(matchNodeFromElement(child as any, tmpl.directives, null));
		}
	}
	return new Map([[partialName, { roots, file: 'test.html', partialName }]]);
}

function emptySpines(): Map<string, ContextSpine[]> {
	return new Map();
}

describe('matchSelectors', () => {
	it('matches a tag selector', () => {
		const partials = setupPartial('<div>hello</div>');
		const rules = [makeRule('div')];
		const result = matchSelectors(rules, partials, emptySpines());
		const matches = result.get('test.html');
		ok(matches);
		strictEqual(matches.length, 1);
		strictEqual(matches[0].matches[0].selector, 'div');
	});

	it('matches a class selector', () => {
		const partials = setupPartial('<div class="card">hello</div>');
		const rules = [makeRule('.card')];
		const result = matchSelectors(rules, partials, emptySpines());
		const matches = result.get('test.html')!;
		strictEqual(matches.length, 1);
		strictEqual(matches[0].matches[0].selector, '.card');
	});

	it('does not match when selector does not apply', () => {
		const partials = setupPartial('<div class="card">hello</div>');
		const rules = [makeRule('.panel')];
		const result = matchSelectors(rules, partials, emptySpines());
		const matches = result.get('test.html');
		strictEqual(matches, undefined);
	});

	it('matches descendant selector with spine ancestors', () => {
		const partials = setupPartial('<span class="title">text</span>');
		const spines = new Map([['test', [{
			ancestors: [{
				tagName: 'div',
				attrs: [{ name: 'class', value: 'card' }],
				dynamicAttrs: [],
				isConditional: false,
				children: [],
				parent: null,
				sourceFile: 'test.html',
				sourceElement: null,
			}],
			isConditional: false,
		}]]]);
		const rules = [makeRule('.card .title')];
		const result = matchSelectors(rules, partials, spines);
		const matches = result.get('test.html')!;
		strictEqual(matches.length, 1);
		strictEqual(matches[0].matches[0].selector, '.card .title');
	});

	it('does not match descendant selector without matching ancestor', () => {
		const partials = setupPartial('<span class="title">text</span>');
		const spines = new Map([['test', [{
			ancestors: [{
				tagName: 'div',
				attrs: [{ name: 'class', value: 'panel' }],
				dynamicAttrs: [],
				isConditional: false,
				children: [],
				parent: null,
				sourceFile: 'test.html',
				sourceElement: null,
			}],
			isConditional: false,
		}]]]);
		const rules = [makeRule('.card .title')];
		const result = matchSelectors(rules, partials, spines);
		strictEqual(result.get('test.html'), undefined);
	});

	it('matches child combinator', () => {
		const partials = setupPartial('<div class="card"><span class="title">text</span></div>');
		const rules = [makeRule('.card > .title')];
		const result = matchSelectors(rules, partials, emptySpines());
		const matches = result.get('test.html')!;
		ok(matches.some(m => m.matches.some(r => r.selector === '.card > .title')));
	});

	it('marks dynamic match type for elements with b-bind:class', () => {
		const partials = setupPartial('<div :class="expr">text</div>');
		const rules = [makeRule('.active')];
		const result = matchSelectors(rules, partials, emptySpines());
		// Dynamic class means we can't definitively say it matches or doesn't
		// The element doesn't have class="active" statically, so it won't match
		strictEqual(result.get('test.html'), undefined);
	});

	it('marks conditional match type when spine is conditional', () => {
		const partials = setupPartial('<span>text</span>');
		const spines = new Map([['test', [{
			ancestors: [{
				tagName: 'div',
				attrs: [],
				dynamicAttrs: [],
				isConditional: true,
				children: [],
				parent: null,
				sourceFile: 'test.html',
				sourceElement: null,
			}],
			isConditional: true,
		}]]]);
		const rules = [makeRule('span')];
		const result = matchSelectors(rules, partials, spines);
		const matches = result.get('test.html')!;
		strictEqual(matches[0].matches[0].matchType, 'conditional');
	});

	it('sorts matches by specificity descending', () => {
		const partials = setupPartial('<div id="main" class="card">text</div>');
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

	it('preserves media conditions from rules', () => {
		const partials = setupPartial('<div class="card">text</div>');
		const rules = [makeRule('.card', { color: 'red' }, ['(min-width:768px)'])];
		const result = matchSelectors(rules, partials, emptySpines());
		const matches = result.get('test.html')!;
		deepStrictEqual(matches[0].matches[0].mediaConditions, ['(min-width:768px)']);
	});

	it('matches across multiple spines (union)', () => {
		const partials = setupPartial('<span class="title">text</span>');
		const spines = new Map([['test', [
			{
				ancestors: [{
					tagName: 'div',
					attrs: [{ name: 'class', value: 'card' }],
					dynamicAttrs: [],
					isConditional: false,
					children: [],
					parent: null,
					sourceFile: 'a.html',
					sourceElement: null,
				}],
				isConditional: false,
			},
			{
				ancestors: [{
					tagName: 'div',
					attrs: [{ name: 'class', value: 'panel' }],
					dynamicAttrs: [],
					isConditional: false,
					children: [],
					parent: null,
					sourceFile: 'b.html',
					sourceElement: null,
				}],
				isConditional: false,
			},
		]]]);
		const rules = [makeRule('.card .title'), makeRule('.panel .title')];
		rules[0].sourceLine = 1;
		rules[1].sourceLine = 2;
		const result = matchSelectors(rules, partials, spines);
		const matches = result.get('test.html')!;
		const sels = matches[0].matches.map(m => m.selector);
		ok(sels.includes('.card .title'));
		ok(sels.includes('.panel .title'));
	});

	it('matches nested elements', () => {
		const partials = setupPartial('<div class="card"><p><span>text</span></p></div>');
		const rules = [makeRule('.card span')];
		const result = matchSelectors(rules, partials, emptySpines());
		const matches = result.get('test.html')!;
		ok(matches.some(m => m.matches.some(r => r.selector === '.card span')));
	});
});
