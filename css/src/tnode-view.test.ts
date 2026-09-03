import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { compileFiles } from '@backflip/html';
import type { AttrPart, TNode } from '@backflip/html';
import { attrIndexOf, buildAttrIndex, isElementLike, tagNameOf } from './tnode-view.js';

/** Compile a snippet as the body of one partial and return its tnodes. */
async function compileBody(html: string, files: Record<string, string> = {}): Promise<TNode[]> {
	const source = `<b-unwrap b-name="t">${html}</b-unwrap>`;
	const { directory, errors } = await compileFiles(new Map([['t.html', source], ...Object.entries(files)]));
	if (errors.length > 0) throw new Error(`compile failed: ${errors.map(e => e.message).join('; ')}`);
	return directory.files.get('t.html')!.partials.get('t')!.tnodes;
}

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
});

describe('the element view of a TNode', () => {
	it('names an element by its tag and indexes its attrs', async () => {
		const [el] = await compileBody('<div class="a" id="main">x</div>');
		ok(isElementLike(el));
		strictEqual(tagNameOf(el), 'div');
		strictEqual(attrIndexOf(el).values.get('class'), 'a');
		strictEqual(attrIndexOf(el).values.get('id'), 'main');
	});

	it('caches the index by the AttrPart array, so repeat lookups share one object', async () => {
		const [el] = await compileBody('<div class="a">x</div>');
		ok(isElementLike(el));
		strictEqual(attrIndexOf(el), attrIndexOf(el));
	});

	it('names a custom-element call by its tag and indexes its call-site attrs', async () => {
		const tnodes = await compileBody(
			'<my-card class="call" title="t">x</my-card>',
			{ 'c.html': '<my-card b-export><div class="body"><b-unwrap b-slot /></div></my-card>' },
		);
		const call = tnodes.find(isElementLike)!;
		strictEqual(tagNameOf(call), 'my-card');
		strictEqual(attrIndexOf(call).values.get('class'), 'call');
		strictEqual(attrIndexOf(call).values.get('title'), 't');
	});

	it('does not treat a b-part call, a slot or interpolation as an element', async () => {
		const tnodes = await compileBody(
			'{{ x }}<b-unwrap b-part="c.html#card" /><b-unwrap b-slot />',
			{ 'c.html': '<div b-name="card" b-export>x</div>' },
		);
		strictEqual(tnodes.filter(isElementLike).length, 0);
	});
});
