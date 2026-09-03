import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { compileFiles } from '@backflip/html';
import type { AttrPart, TNode } from '@backflip/html';
import {
	attrIndexOf, buildAttrIndex, buildElementView, collectBPartRefs, findBPartRefInRange,
	isElementLike, tagNameOf, type ElementLikeTNode, type ElementView,
} from './tnode-view.js';

/** Compile a snippet as the body of one partial and return its tnodes. */
async function compileBody(html: string, files: Record<string, string> = {}): Promise<TNode[]> {
	const source = `<b-unwrap b-name="t">${html}</b-unwrap>`;
	const { directory, errors } = await compileFiles(new Map([['t.html', source], ...Object.entries(files)]));
	if (errors.length > 0) throw new Error(`compile failed: ${errors.map(e => e.message).join('; ')}`);
	return directory.files.get('t.html')!.partials.get('t')!.tnodes;
}

async function viewOf(html: string, files: Record<string, string> = {}): Promise<ElementView> {
	return buildElementView(await compileBody(html, files));
}

const names = (nodes: ElementLikeTNode[]) => nodes.map(tagNameOf);

describe('buildAttrIndex', () => {
	const staticPart = (raw: string): AttrPart => ({ type: 'static', raw });

	it('reads double-quoted, single-quoted, unquoted and bare attributes', () => {
		const index = buildAttrIndex([staticPart(` class="a b" id='main' data-n=7 hidden`)]);
		strictEqual(index.values.get('class'), 'a b');
		strictEqual(index.values.get('id'), 'main');
		strictEqual(index.values.get('data-n'), '7');
		strictEqual(index.values.get('hidden'), '');
		ok(index.values.has('hidden'), 'a bare attribute is present with an empty value');
	});

	it('lowercases names and keeps the first of a duplicate', () => {
		const index = buildAttrIndex([staticPart(` CLASS="first" class="second"`)]);
		strictEqual(index.values.get('class'), 'first');
	});

	it('merges several static parts, keeping source order', () => {
		const index = buildAttrIndex([staticPart(` class="a"`), staticPart(` id="b"`)]);
		strictEqual(index.values.get('class'), 'a');
		strictEqual(index.values.get('id'), 'b');
	});

	it('records a runtime-bound attribute as dynamic with no value', () => {
		const index = buildAttrIndex([
			{ type: 'dynamic', name: 'class', expr: null as any, isBoolean: false },
			staticPart(` id="x"`),
		]);
		ok(index.dynamic.has('class'));
		strictEqual(index.values.has('class'), false);
		strictEqual(index.values.get('id'), 'x');
	});

	it('uses an asset reference\'s source text as the attribute value', () => {
		const index = buildAttrIndex([
			{ type: 'asset', attrName: 'src', originalValue: '@images/a.png', refs: [] },
		]);
		strictEqual(index.values.get('src'), '@images/a.png');
	});

	it('indexes a custom-element call by its call-site attrs', async () => {
		const view = await viewOf(
			'<my-card class="call" title="t">x</my-card>',
			{ 'c.html': '<my-card b-export><div class="body"><b-unwrap b-slot /></div></my-card>' },
		);
		const call = view.all[0];
		strictEqual(tagNameOf(call), 'my-card');
		strictEqual(attrIndexOf(call).values.get('class'), 'call');
		strictEqual(attrIndexOf(call).values.get('title'), 't');
	});
});

describe('buildElementView', () => {
	it('links parents and children, ignoring text and interpolation', async () => {
		const view = await viewOf('<div class="a">text {{ x }}<span>y</span></div>');
		deepStrictEqual(names(view.tops), ['div']);
		deepStrictEqual(names(view.all), ['div', 'span']);
		const [div, span] = view.all;
		deepStrictEqual(view.children.get(div), [span]);
		strictEqual(view.parent.get(span), div);
		strictEqual(view.parent.get(div), null);
		deepStrictEqual(view.children.get(span), []);
	});

	it('treats b-for as transparent', async () => {
		const view = await viewOf('<ul><li b-for="i in items">x</li></ul>');
		deepStrictEqual(names(view.all), ['ul', 'li']);
		strictEqual(view.parent.get(view.all[1]), view.all[0]);
		strictEqual(view.conditional.has(view.all[1]), false, 'b-for alone is not conditional');
	});

	it('walks every b-if branch and marks only the tag carrying the directive', async () => {
		const view = await viewOf([
			'<div b-if="c" class="a"><span class="in">x</span></div>',
			'<div b-else class="b">y</div>',
		].join(''));
		deepStrictEqual(names(view.all), ['div', 'span', 'div']);
		const [ifDiv, inner, elseDiv] = view.all;
		ok(view.conditional.has(ifDiv));
		ok(view.conditional.has(elseDiv));
		strictEqual(view.conditional.has(inner), false);
		// Both branches are siblings at the top of the tree.
		deepStrictEqual(view.tops, [ifDiv, elseDiv]);
	});

	it('shows b-part slot content under the tag that carries the call', async () => {
		const view = await viewOf(
			'<div class="host" b-part="c.html#card"><h2 b-in="header">t</h2></div>',
			{ 'c.html': '<div b-name="card" b-export><div class="hd"><b-unwrap b-slot="header" /></div></div>' },
		);
		deepStrictEqual(names(view.all), ['div', 'h2']);
		strictEqual(view.parent.get(view.all[1]), view.all[0], 'slot content is a child of the carrying tag');
	});

	it('makes a custom-element call an element whose children are its slot content', async () => {
		const view = await viewOf(
			'<my-card class="call"><span>x</span></my-card>',
			{ 'c.html': '<my-card b-export><div class="body"><b-unwrap b-slot /></div></my-card>' },
		);
		deepStrictEqual(names(view.all), ['my-card', 'span']);
		ok(isElementLike(view.all[0]));
		strictEqual(view.parent.get(view.all[1]), view.all[0]);
	});

	it('returns an empty view for a body with no elements', async () => {
		const view = await viewOf('just text {{ x }}');
		deepStrictEqual(view.all, []);
		deepStrictEqual(view.tops, []);
	});
});

describe('locating b-part calls by source offset', () => {
	it('finds the call written inside a given open tag', async () => {
		const source = [
			'<div b-name="page">',
			'  <div class="host" b-part="#card">',
			'    <h2 b-in="header">t</h2>',
			'  </div>',
			'</div>',
			'<div b-name="card"><b-unwrap b-slot="header" /></div>',
		].join('\n');
		const { directory, errors } = await compileFiles(new Map([['t.html', source]]));
		strictEqual(errors.length, 0);
		const refs = collectBPartRefs(directory.files.get('t.html')!);
		strictEqual(refs.length, 1);

		const openTagStart = source.indexOf('<div class="host"');
		const openTagEnd = source.indexOf('>', openTagStart) + 1;
		const ref = findBPartRefInRange(refs, openTagStart, openTagEnd, 'card');
		ok(ref, 'the call inside the open tag is found');
		strictEqual(ref!.partialName, 'card');
		ok(ref!.slots['header'], 'its slot content comes with it');

		// A range that does not contain the b-part value finds nothing.
		strictEqual(findBPartRefInRange(refs, 0, openTagStart, 'card'), null);
		// Neither does a mismatched partial name.
		strictEqual(findBPartRefInRange(refs, openTagStart, openTagEnd, 'other'), null);
	});

	it('picks the outer call when one b-part is nested in another\'s slot content', async () => {
		const source = [
			'<div b-name="page">',
			'  <div class="outer" b-part="#card">',
			'    <div b-in="header" b-part="#card"><span b-in="header">x</span></div>',
			'  </div>',
			'</div>',
			'<div b-name="card"><div class="hd"><b-unwrap b-slot="header" /></div></div>',
		].join('\n');
		const { directory } = await compileFiles(new Map([['t.html', source]]));
		const refs = collectBPartRefs(directory.files.get('t.html')!);
		strictEqual(refs.length, 2);

		const outerStart = source.indexOf('<div class="outer"');
		const outerEnd = source.indexOf('>', outerStart) + 1;
		const outer = findBPartRefInRange(refs, outerStart, outerEnd, 'card')!;
		ok(outer);
		// The outer call's slot holds the inner call's carrying tag, not the inner call itself.
		const view = buildElementView(outer.slots['header']);
		deepStrictEqual(names(view.tops), ['div']);
	});
});
