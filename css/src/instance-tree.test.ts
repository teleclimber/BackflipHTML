import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { compileFiles } from '@backflip/html';
import { tagNameOf } from './tnode-view.js';
import {
	attrsOf, buildInstanceForest, childrenOf, siblingsOf,
	MAX_DEPTH, MAX_INSTANCES, type InstanceForest, type InstanceNode,
} from './instance-tree.js';

/**
 * Compile some templates and expand them. Compile errors are deliberately not
 * thrown: the LSP analyses broken trees, and several cases below are broken on
 * purpose (an unknown custom element, a self-recursive partial).
 */
async function forestOf(files: Record<string, string>): Promise<InstanceForest> {
	const { directory } = await compileFiles(new Map(Object.entries(files)));
	return buildInstanceForest(directory.files);
}

const tag = (n: InstanceNode) => tagNameOf(n.tnode);
const cls = (n: InstanceNode) => attrsOf(n).values.get('class');

/** `tag.class` for each instance, in document order. */
const shape = (forest: InstanceForest) =>
	forest.all.map(n => (cls(n) ? `${tag(n)}.${cls(n)}` : tag(n)));

/** The chain of ancestors down to `n`, outermost first. */
function ancestry(n: InstanceNode): string[] {
	const out: string[] = [];
	for (let cur: InstanceNode | null = n; cur; cur = cur.parent) {
		out.unshift(cls(cur) ? `${tag(cur)}.${cls(cur)}` : tag(cur));
	}
	return out;
}

function find(forest: InstanceForest, className: string): InstanceNode {
	const found = forest.all.find(n => cls(n)?.split(/\s+/).includes(className));
	ok(found, `no instance carries class="${className}"`);
	return found!;
}

describe('roots', () => {
	it('expands only the partials nothing calls, and reaches the rest through them', async () => {
		const forest = await forestOf({
			'page.html': '<div b-name="page" class="page"><b-unwrap b-part="c.html#card" /></div>',
			'c.html': '<div b-name="card" b-export class="card"><span class="t">x</span></div>',
		});
		deepStrictEqual(shape(forest), ['div.page', 'div.card', 'span.t']);
		strictEqual(forest.tops.length, 1, 'card is not a root of its own — page calls it');
	});

	it('expands a partial nobody calls against an empty context', async () => {
		const forest = await forestOf({
			'page.html': '<div b-name="page" class="page">x</div><div b-name="loose" class="loose">y</div>',
		});
		deepStrictEqual(shape(forest), ['div.page', 'div.loose']);
	});

	it('expands a partial reachable only through a reference cycle, once', async () => {
		const forest = await forestOf({
			't.html': [
				'<div b-name="a" class="a"><b-unwrap b-part="#b" /></div>',
				'<div b-name="b" class="b"><b-unwrap b-part="#a" /></div>',
			].join('\n'),
		});
		// Neither is a root (each is called), so one is grown standalone and the
		// other is reached from it — not grown a second time.
		const roots = forest.all.filter(n => n.parent === null);
		strictEqual(roots.length, 1);
		strictEqual(cls(roots[0]), 'a');
	});

	it('gives a standalone custom-element partial the tag its call site would render', async () => {
		const forest = await forestOf({
			'c.html': '<my-card b-export class="def"><span class="in">x</span></my-card>',
		});
		deepStrictEqual(shape(forest), ['my-card.def', 'span.in']);
	});
});

describe('expansion rules', () => {
	it('makes the tag carrying a b-part the parent of the partial it calls', async () => {
		const forest = await forestOf({
			't.html': [
				'<div b-name="page"><div class="wrap" b-part="#card"></div></div>',
				'<div b-name="card" class="card"><p class="item">x</p></div>',
			].join('\n'),
		});
		deepStrictEqual(ancestry(find(forest, 'item')), ['div', 'div.wrap', 'div.card', 'p.item']);
	});

	it('splices a b-unwrap b-part call in with no tag of its own', async () => {
		const forest = await forestOf({
			't.html': [
				'<div b-name="page" class="page"><b-unwrap b-part="#card" /></div>',
				'<div b-name="card" class="card">x</div>',
			].join('\n'),
		});
		deepStrictEqual(ancestry(find(forest, 'card')), ['div.page', 'div.card']);
	});

	it('renders a custom-element call as one tag with caller attrs before definition attrs', async () => {
		const forest = await forestOf({
			'page.html': '<div b-name="page"><my-card class="call" title="caller">x</my-card></div>',
			'c.html': '<my-card b-export title="definition" data-role="card"><b class="body"><b-unwrap b-slot /></b></my-card>',
		});
		const call = find(forest, 'call');
		strictEqual(tag(call), 'my-card');
		strictEqual(attrsOf(call).values.get('title'), 'caller', 'the call site wins a duplicate');
		strictEqual(attrsOf(call).values.get('data-role'), 'card', 'definition-only attrs are there too');
		deepStrictEqual(ancestry(find(forest, 'body')), ['div', 'my-card.call', 'b.body']);
	});

	it('falls back to caller attrs and the default slot for an unknown custom element', async () => {
		const forest = await forestOf({
			'page.html': '<div b-name="page"><un-known class="call"><i class="fill">x</i></un-known></div>',
		});
		const call = find(forest, 'call');
		strictEqual(tag(call), 'un-known');
		deepStrictEqual(ancestry(find(forest, 'fill')), ['div', 'un-known.call', 'i.fill']);
	});

	it('repeats a b-for body, and leaves the repeats unconditional', async () => {
		const forest = await forestOf({
			't.html': '<ul b-name="list" class="list"><li b-for="i in items" class="item">x</li></ul>',
		});
		const items = forest.all.filter(n => cls(n) === 'item');
		strictEqual(items.length, 3);
		ok(items.every(n => !n.conditional));
		strictEqual(childrenOf(find(forest, 'list'), forest.ctx).length, 3);
	});

	it('models every b-if branch as present, marking each branch top conditional', async () => {
		const forest = await forestOf({
			't.html': [
				'<div b-name="page">',
				'  <div b-if="c" class="a"><span class="in">x</span></div>',
				'  <div b-else class="b">y</div>',
				'</div>',
			].join('\n'),
		});
		ok(find(forest, 'a').conditional);
		ok(find(forest, 'b').conditional);
		strictEqual(find(forest, 'in').conditional, false,
			'an element boundary resets conditionality');
	});

	it('marks a partial called from inside a b-if branch conditional', async () => {
		const forest = await forestOf({
			't.html': [
				'<div b-name="page"><b-unwrap b-if="c"><b-unwrap b-part="#card" /></b-unwrap></div>',
				'<div b-name="card" class="card"><i class="deep">x</i></div>',
			].join('\n'),
		});
		ok(find(forest, 'card').conditional);
		strictEqual(find(forest, 'deep').conditional, false);
	});
});

describe('slot environments', () => {
	it('renders a fill where the slot is, in the environment it was written in', async () => {
		const forest = await forestOf({
			't.html': [
				'<div b-name="card" class="card"><div class="hd"><b-unwrap b-slot="header" /></div></div>',
				'<div b-name="page" class="page"><b-unwrap b-part="#card"><h2 b-in="header" class="fill">t</h2></b-unwrap></div>',
			].join('\n'),
		});
		deepStrictEqual(ancestry(find(forest, 'fill')),
			['div.page', 'div.card', 'div.hd', 'h2.fill']);
	});

	it('forwards a slot through two levels of partial', async () => {
		const forest = await forestOf({
			't.html': [
				'<div b-name="inner" class="inner"><b-unwrap b-slot="deep" /></div>',
				'<div b-name="outer" class="outer"><b-unwrap b-part="#inner"><b-unwrap b-in="deep" b-slot="fwd" /></b-unwrap></div>',
				'<div b-name="page" class="page"><b-unwrap b-part="#outer"><b class="leaf">x</b></b-unwrap></div>',
			].join('\n'),
		});
		// `fwd` is never filled — the page fills the default slot — so nothing lands.
		strictEqual(forest.all.some(n => cls(n) === 'leaf'), false);

		const filled = await forestOf({
			't.html': [
				'<div b-name="inner" class="inner"><b-unwrap b-slot="deep" /></div>',
				'<div b-name="outer" class="outer"><b-unwrap b-part="#inner"><b-unwrap b-in="deep" b-slot="fwd" /></b-unwrap></div>',
				'<div b-name="page" class="page"><b-unwrap b-part="#outer"><b class="leaf" b-in="fwd">x</b></b-unwrap></div>',
			].join('\n'),
		});
		deepStrictEqual(ancestry(find(filled, 'leaf')),
			['div.page', 'div.outer', 'div.inner', 'b.leaf']);
	});

	it('keeps a fill in its own file and partial, not the callee\'s', async () => {
		const forest = await forestOf({
			'c.html': '<div b-name="card" b-export class="card"><b-unwrap b-slot /></div>',
			'page.html': '<div b-name="page"><b-unwrap b-part="c.html#card"><p class="fill">x</p></b-unwrap></div>',
		});
		const fill = find(forest, 'fill');
		strictEqual(fill.file, 'page.html');
		strictEqual(fill.partialName, 'page');
		const card = find(forest, 'card');
		strictEqual(card.file, 'c.html');
		strictEqual(card.partialName, 'card');
	});
});

describe('identity', () => {
	it('hands back the same node and the same array every time', async () => {
		const forest = await forestOf({
			't.html': '<div b-name="page" class="row"><p class="a">1</p><p class="b">2</p></div>',
		});
		const row = find(forest, 'row');
		strictEqual(childrenOf(row, forest.ctx), childrenOf(row, forest.ctx));

		const a = find(forest, 'a');
		const siblings = siblingsOf(a, forest.ctx);
		strictEqual(siblings, childrenOf(row, forest.ctx));
		ok(siblings.includes(a), 'a node is found among its own siblings by identity');
		strictEqual(siblings.indexOf(a), 0);
	});

	it('gives a root instance a null parent and a stable sibling list', async () => {
		const forest = await forestOf({
			't.html': '<b-unwrap b-name="page"><p class="a">1</p><p class="b">2</p></b-unwrap>',
		});
		const a = find(forest, 'a');
		strictEqual(a.parent, null);
		const siblings = siblingsOf(a, forest.ctx);
		strictEqual(siblings.length, 2);
		strictEqual(siblings, siblingsOf(find(forest, 'b'), forest.ctx));
	});
});

describe('budgets', () => {
	it('stops a self-recursive partial at the depth cap', async () => {
		const forest = await forestOf({
			't.html': '<div b-name="r" class="r"><b-unwrap b-part="#r" /></div>',
		});
		strictEqual(forest.all.length, MAX_DEPTH + 1);
		strictEqual(forest.truncated, false);
		strictEqual(forest.all[forest.all.length - 1].depth, MAX_DEPTH);
	});

	it('stops a self-recursive partial that renders no tag at all', async () => {
		const forest = await forestOf({
			't.html': '<b-unwrap b-name="r"><b-unwrap b-part="#r" /></b-unwrap>',
		});
		strictEqual(forest.all.length, 0);
	});

	it('stops at the instance budget without throwing', async () => {
		// 11 nested b-for levels: 3^11 leaves, well past the budget.
		const depth = 11;
		const body = '<span class="leaf">x</span>';
		let html = body;
		for (let i = depth; i > 0; i--) html = `<div b-for="v${i} in xs" class="l${i}">${html}</div>`;
		const forest = await forestOf({ 't.html': `<div b-name="page">${html}</div>` });
		strictEqual(forest.truncated, true);
		strictEqual(forest.all.length, MAX_INSTANCES);
	});
});
