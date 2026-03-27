import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { parseTemplate, buildPartialInfo } from './parse-dom.js';
import { buildUsageGraph } from './usage-graph.js';
import { computeSpines } from './context-spines.js';

function buildGraph(templates: { html: string; file: string }[]) {
	const parsed = templates.map(t => parseTemplate(t.html, t.file, buildPartialInfo(t.html)));
	return buildUsageGraph(parsed);
}

describe('computeSpines', () => {
	it('returns single empty spine when partial has no usage sites', () => {
		const graph = buildGraph([
			{ html: '<div b-name="card">content</div>', file: 'a.html' },
		]);
		const spines = computeSpines('card', graph);
		strictEqual(spines.length, 1);
		strictEqual(spines[0].ancestors.length, 0);
		strictEqual(spines[0].isConditional, false);
	});

	it('returns single empty spine for completely unknown partial', () => {
		const graph = buildGraph([
			{ html: '<div>hello</div>', file: 'a.html' },
		]);
		const spines = computeSpines('nonexistent', graph);
		strictEqual(spines.length, 1);
		strictEqual(spines[0].ancestors.length, 0);
		strictEqual(spines[0].isConditional, false);
	});

	it('computes spine for a single usage with one ancestor', () => {
		const graph = buildGraph([
			{
				html: '<div class="container"><div b-part="card"></div></div><div b-name="card">content</div>',
				file: 'a.html',
			},
		]);
		const spines = computeSpines('card', graph);
		strictEqual(spines.length, 1);
		strictEqual(spines[0].ancestors.length, 1);
		strictEqual(spines[0].ancestors[0].tagName, 'div');
		const classAttr = spines[0].ancestors[0].attrs.find(a => a.name === 'class');
		strictEqual(classAttr?.value, 'container');
		strictEqual(spines[0].isConditional, false);
	});

	it('computes spines for multiple usages in different containers', () => {
		const graph = buildGraph([
			{
				html: '<section><div b-part="card"></div></section><article><div b-part="card"></div></article><div b-name="card">content</div>',
				file: 'a.html',
			},
		]);
		const spines = computeSpines('card', graph);
		strictEqual(spines.length, 2);

		const tagNames = spines.map(s => s.ancestors[0].tagName).sort();
		deepStrictEqual(tagNames, ['article', 'section']);
	});

	it('marks spine as conditional when an ancestor has b-if', () => {
		const graph = buildGraph([
			{
				html: '<div b-if="show"><div b-part="card"></div></div><div b-name="card">content</div>',
				file: 'a.html',
			},
		]);
		const spines = computeSpines('card', graph);
		strictEqual(spines.length, 1);
		strictEqual(spines[0].isConditional, true);
		strictEqual(spines[0].ancestors[0].isConditional, true);
	});

	it('marks spine as conditional when an ancestor has b-else-if', () => {
		const graph = buildGraph([
			{
				html: '<div b-if="a">A</div><div b-else-if="b"><div b-part="card"></div></div><div b-name="card">content</div>',
				file: 'a.html',
			},
		]);
		const spines = computeSpines('card', graph);
		strictEqual(spines.length, 1);
		strictEqual(spines[0].isConditional, true);
	});

	it('marks spine as conditional when an ancestor has b-else', () => {
		const graph = buildGraph([
			{
				html: '<div b-if="a">A</div><div b-else><div b-part="card"></div></div><div b-name="card">content</div>',
				file: 'a.html',
			},
		]);
		const spines = computeSpines('card', graph);
		strictEqual(spines.length, 1);
		strictEqual(spines[0].isConditional, true);
	});

	it('skips b-unwrap elements in ancestor chain', () => {
		const graph = buildGraph([
			{
				html: '<div class="outer"><b-unwrap><div b-part="card"></div></b-unwrap></div><div b-name="card">content</div>',
				file: 'a.html',
			},
		]);
		const spines = computeSpines('card', graph);
		strictEqual(spines.length, 1);
		// b-unwrap should be skipped, only div.outer should appear
		const tags = spines[0].ancestors.map(a => a.tagName);
		ok(!tags.includes('b-unwrap'), 'b-unwrap should not appear in spine');
		strictEqual(tags.length, 1);
		strictEqual(tags[0], 'div');
	});

	it('handles nested partials by prepending outer spine', () => {
		const graph = buildGraph([
			{
				html: [
					'<div class="page"><div b-part="outer"></div></div>',
					'<div b-name="outer"><span><div b-part="inner"></div></span></div>',
					'<div b-name="inner">content</div>',
				].join(''),
				file: 'a.html',
			},
		]);
		const spines = computeSpines('inner', graph);
		strictEqual(spines.length, 1);
		// Should include: div.page (from outer's usage) + span (from inside outer's definition)
		const tags = spines[0].ancestors.map(a => a.tagName);
		deepStrictEqual(tags, ['div', 'span']);
		const classAttr = spines[0].ancestors[0].attrs.find(a => a.name === 'class');
		strictEqual(classAttr?.value, 'page');
	});

	it('respects maxDepth to prevent infinite recursion', () => {
		// Create a cycle: partial A uses partial B, partial B uses partial A
		// This is pathological, but maxDepth should prevent infinite recursion
		const graph = buildGraph([
			{
				html: '<div b-name="alpha"><div b-part="beta"></div></div><div b-name="beta"><div b-part="alpha"></div></div><div><div b-part="alpha"></div></div>',
				file: 'a.html',
			},
		]);
		// Should not throw — maxDepth stops recursion
		const spines = computeSpines('alpha', graph, 3);
		ok(spines.length > 0, 'Should return at least one spine');
	});

	it('collects multiple ancestors from outermost to innermost', () => {
		const graph = buildGraph([
			{
				html: '<main><section><article><div b-part="card"></div></article></section></main><div b-name="card">content</div>',
				file: 'a.html',
			},
		]);
		const spines = computeSpines('card', graph);
		strictEqual(spines.length, 1);
		const tags = spines[0].ancestors.map(a => a.tagName);
		deepStrictEqual(tags, ['main', 'section', 'article']);
	});

	it('copies dynamicAttrs into SpineNode', () => {
		const graph = buildGraph([
			{
				html: '<div :class="expr"><div b-part="card"></div></div><div b-name="card">content</div>',
				file: 'a.html',
			},
		]);
		const spines = computeSpines('card', graph);
		strictEqual(spines.length, 1);
		deepStrictEqual(spines[0].ancestors[0].dynamicAttrs, ['class']);
	});

	it('stores sourceFile on SpineNode', () => {
		const graph = buildGraph([
			{
				html: '<div><div b-part="card"></div></div><div b-name="card">content</div>',
				file: 'page.html',
			},
		]);
		const spines = computeSpines('card', graph);
		strictEqual(spines[0].ancestors[0].sourceFile, 'page.html');
	});
});
