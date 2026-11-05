import { assertEquals, assertStringIncludes } from "jsr:@std/assert";

import { compileFile } from "../../test-helpers.ts";
import type { CompiledFile, CustomElementPartialRoot, TNode } from "../../types.ts";
import { makeSequentialBfidGen } from "./bfid.ts";
import { applyDomPatch } from "./nodes2patch.ts";
import { evalModule } from "./test-helpers.ts";

// The fixtures use a b-attr as an iterable; these tests are about what the generator
// produces, and the rule against that is checked on the whole project, not here.
async function compile(html: string): Promise<CompiledFile> {
	const { compiled, errors } = await compileFile(html);
	const fatal = errors.filter(e => e.severity !== 'warning');
	if (fatal.length > 0) throw new Error('compile errors: ' + fatal.map(e => e.message).join(', '));
	return compiled;
}

async function generate(html: string) {
	const file = await compile(html);
	const { modules } = applyDomPatch(file, { bfidGen: makeSequentialBfidGen() });
	return { file, js: modules[0]?.js ?? null, root: file.partials.get('my-widget') as CustomElementPartialRoot };
}

function allComments(tnodes: TNode[]): string[] {
	return tnodes.flatMap(n => {
		if (n.type === 'comment') return [n.text];
		if (n.type === 'element' || n.type === 'for') return allComments(n.tnodes);
		if (n.type === 'if') return n.branches.flatMap(b => allComments(b.tnodes));
		return [];
	});
}

const LIST = `<my-widget b-attr:xs b-generate="render"><ul><li b-for="x in xs" b-key="x.id" :title="x.name">{{ x.name }}</li></ul></my-widget>`;

// --- the loop descriptor ---

Deno.test("loop: a keyed loop gets a descriptor, anchored like a set", async () => {
	const { js } = await generate(LIST);
	const root = evalModule(js!, 'my-widget').bfRoot;
	assertEquals(root.loops.length, 1);
	const loop = root.loops[0];
	const [start, end] = loop.markers;
	assertEquals(typeof loop.bfid, 'string');
	assertEquals(start.startsWith('bfid:'), true);
	assertEquals(end.startsWith('bfid:'), true);
	assertEquals(loop.itemMarker, `bfitem:${start.slice('bfid:'.length)}`);
});

Deno.test("loop: a loop directly in the custom element targets the ref element", async () => {
	const { js } = await generate(`<my-widget b-attr:xs b-generate="render"><li b-for="x in xs" b-key="x">a</li></my-widget>`);
	assertEquals(evalModule(js!, 'my-widget').bfRoot.loops[0].bfid, null);
});

Deno.test("loop: the key is emitted as an expression", async () => {
	const { js } = await generate(LIST);
	const { key } = evalModule(js!, 'my-widget').bfRoot.loops[0];
	assertEquals(key.vars, ['x']);
	assertEquals(key.fn({ id: 7 }), 7);
});

Deno.test("loop: the snapshot is a module const holding the iterable, the names and the item's nodes", async () => {
	const { js } = await generate(`<my-widget b-attr:xs b-generate="render"><li b-for="x, i in xs" b-key="i">{{ x }}</li></my-widget>`);
	const { bfRoot, defined } = evalModule(js!, 'my-widget');
	const loop = bfRoot.loops[0];
	const id = loop.markers[0].slice('bfid:'.length);
	assertEquals(loop.snapshot, defined[`bffor_${id}`]);
	assertEquals(loop.snapshot.type, 'for');
	assertEquals(loop.snapshot.iterable.vars, ['xs']);
	assertEquals([loop.snapshot.valName, loop.snapshot.indexName], ['x', 'i']);
	assertEquals(loop.snapshot.nodes[0], { type: 'comment', text: loop.itemMarker });
});

Deno.test("loop: the snapshot carries every marker the item's sites use", async () => {
	const { js } = await generate(LIST);
	const { item, snapshot } = evalModule(js!, 'my-widget').bfRoot.loops[0];
	const text = JSON.stringify(snapshot.nodes);
	assertStringIncludes(text, `data-bfid=\\"${item.sites[0].bfid}\\"`);
	const print = item.sites.find((s: { markers?: string[] }) => s.markers);
	for (const m of print.markers) assertStringIncludes(text, m);
});

Deno.test("loop: its item is a branch of its own, with sites that read the loop's names", async () => {
	const { js } = await generate(LIST);
	const { bfRoot } = evalModule(js!, 'my-widget');
	assertEquals(bfRoot.sites, []);
	const { sites } = bfRoot.loops[0].item;
	assertEquals(sites.length, 2);
	assertEquals(sites.map((s: { expr: { vars: string[] } }) => s.expr.vars), [['x'], ['x']]);
});

Deno.test("loop: a site on the item's root element is found by data-bfid, since items share a parent", async () => {
	const { js } = await generate(LIST);
	const { item } = evalModule(js!, 'my-widget').bfRoot.loops[0];
	const attr = item.sites.find((s: { attr?: string }) => s.attr === 'title');
	assertEquals(typeof attr.bfid, 'string');
});

Deno.test("loop: a print directly in a b-unwrap item targets the parent, limited by the item at runtime", async () => {
	const { js } = await generate(`<my-widget b-attr:xs b-generate="render"><ul><b-unwrap b-for="x in xs" b-key="x">{{ x }}</b-unwrap></ul></my-widget>`);
	const loop = evalModule(js!, 'my-widget').bfRoot.loops[0];
	assertEquals(loop.item.sites[0].bfid, null);
});

Deno.test("loop: an item with nothing to patch still gets a descriptor, for adding and removing", async () => {
	const { js } = await generate(`<my-widget b-attr:xs b-generate="render"><li b-for="x in xs" b-key="x">static</li></my-widget>`);
	const { item } = evalModule(js!, 'my-widget').bfRoot.loops[0];
	assertEquals([item.sites, item.sets], [[], []]);
});

Deno.test("loop: a site reading only an outer variable is patched in the item", async () => {
	const { js } = await generate(`<my-widget b-attr:xs b-attr:title b-generate="render"><li b-for="x in xs" b-key="x" :title="title">a</li></my-widget>`);
	const { sites } = evalModule(js!, 'my-widget').bfRoot.loops[0].item;
	assertEquals(sites[0].expr.vars, ['title']);
});

Deno.test("loop: a branch with no loops has no loops key, so its generated code is unchanged", async () => {
	const { js } = await generate(`<my-widget b-attr:title b-generate="render"><p>{{ title }}</p></my-widget>`);
	assertEquals(js!.includes('loops'), false);
});

// --- markers in the AST, and so in the server-rendered HTML ---

Deno.test("loop: the AST gets a marker pair around the loop and an item marker opening the body", async () => {
	const { root } = await generate(`<my-widget b-attr:xs b-generate="render"><li b-for="x in xs" b-key="x">a</li></my-widget>`);
	const [start, loop, end] = root.tnodes;
	assertEquals([start.type, loop.type, end.type], ['comment', 'for', 'comment']);
	if (loop.type !== 'for' || start.type !== 'comment') throw new Error('unexpected shape');
	assertEquals(loop.tnodes[0], { type: 'comment', text: `bfitem:${start.text.slice('bfid:'.length)}` });
});

Deno.test("loop: running the pass twice adds no markers and yields the same module", async () => {
	const file = await compile(LIST);
	const first = applyDomPatch(file, { bfidGen: makeSequentialBfidGen() }).modules[0].js;
	const root = file.partials.get('my-widget')!;
	const comments = allComments(root.tnodes);
	const second = applyDomPatch(file, { bfidGen: makeSequentialBfidGen() }).modules[0].js;
	assertEquals(allComments(root.tnodes), comments);
	assertEquals(second, first);
});

// --- nesting ---

Deno.test("loop: a set in an item belongs to the item, and reads the loop's names", async () => {
	const { js } = await generate(`<my-widget b-attr:xs b-generate="render"><li b-for="x in xs" b-key="x.id"><b b-if="x.on">on</b></li></my-widget>`);
	const { bfRoot } = evalModule(js!, 'my-widget');
	assertEquals(bfRoot.sets, []);
	const { sets } = bfRoot.loops[0].item;
	assertEquals(sets.length, 1);
});

Deno.test("loop: a loop in an item nests, and the outer snapshot names the inner one", async () => {
	const { js } = await generate(`<my-widget b-attr:rows b-generate="render"><tr b-for="r in rows" b-key="r.id"><td b-for="c in r.cells" b-key="c">{{ c }}</td></tr></my-widget>`);
	const { bfRoot, defined } = evalModule(js!, 'my-widget');
	const outer = bfRoot.loops[0];
	const inner = outer.item.loops[0];
	assertEquals(inner.snapshot, defined[`bffor_${inner.markers[0].slice('bfid:'.length)}`]);
	assertEquals(inner.snapshot.iterable.vars, ['r']);
	const inSnapshot = JSON.stringify(outer.snapshot.nodes, (_k, v) => v === inner.snapshot ? 'INNER' : v);
	assertStringIncludes(inSnapshot, 'INNER');
});

Deno.test("loop: a loop in a reactive set's branch belongs to that branch, and the set's snapshot names it", async () => {
	const { js } = await generate(`<my-widget b-attr:xs b-attr:on b-generate="render"><div b-if="on"><p b-for="x in xs" b-key="x">{{ x }}</p></div></my-widget>`);
	const { bfRoot } = evalModule(js!, 'my-widget');
	assertEquals(bfRoot.loops, undefined);
	const loop = bfRoot.sets[0].branches[0].loops[0];
	const inSnapshot = JSON.stringify(bfRoot.sets[0].snapshot, (_k, v) => v === loop.snapshot ? 'INNER' : v);
	assertStringIncludes(inSnapshot, 'INNER');
});

Deno.test("loop: a set in an item and a loop in its branch can nest further", async () => {
	const { js } = await generate(`<my-widget b-attr:rows b-generate="render"><div b-for="r in rows" b-key="r.id"><div b-if="r.on"><p b-for="c in r.cells" b-key="c">{{ c }}</p></div></div></my-widget>`);
	const { bfRoot } = evalModule(js!, 'my-widget');
	assertEquals(bfRoot.loops[0].item.sets[0].branches[0].loops[0].snapshot.iterable.vars, ['r']);
});

// --- what disqualifies a loop ---

for (const [label, body] of Object.entries({
	'a custom element call': `<li b-for="x in xs" b-key="x"><other-thing></other-thing></li>`,
	'a custom element call as the loop': `<other-thing b-for="x in xs" b-key="x"></other-thing>`,
	'a b-part call': `<li b-for="x in xs" b-key="x"><b-unwrap b-part="#thing"></b-unwrap></li>`,
	'a slot': `<li b-for="x in xs" b-key="x"><span b-slot></span></li>`,
	'a nested disqualifier': `<ul b-for="x in xs" b-key="x"><li b-for="y in x" b-key="y"><other-thing></other-thing></li></ul>`,
})) {
	Deno.test(`loop: ${label} in the body makes it non-reactive, with no markers`, async () => {
		const file = await compile(`<my-widget b-attr:xs b-generate="render">${body}</my-widget>`);
		const { modules } = applyDomPatch(file, { bfidGen: makeSequentialBfidGen() });
		assertEquals(modules, []);
		assertEquals(allComments(file.partials.get('my-widget')!.tnodes), []);
	});
}

Deno.test("loop: a disqualifier in a loop sinks the set around it", async () => {
	const file = await compile(`<my-widget b-attr:xs b-attr:on b-generate="render"><div b-if="on"><li b-for="x in xs" b-key="x"><other-thing></other-thing></li></div></my-widget>`);
	assertEquals(applyDomPatch(file, { bfidGen: makeSequentialBfidGen() }).modules, []);
});

Deno.test("loop: sites in a non-reactive loop stay unpatched, while other sites still patch", async () => {
	const { js } = await generate(`<my-widget b-attr:xs b-attr:title b-generate="render"><p>{{ title }}</p><li b-for="x in xs" b-key="x" :title="title"><other-thing></other-thing></li></my-widget>`);
	const { bfRoot } = evalModule(js!, 'my-widget');
	assertEquals(bfRoot.sites.length, 1);
	assertEquals(bfRoot.loops, undefined);
});

Deno.test("loop: an iterable naming no variable is not a loop site", async () => {
	const { js } = await generate(`<my-widget b-attr:title b-generate="render"><li b-for="x in 'ab'" b-key="x">{{ title }}</li></my-widget>`);
	assertEquals(js, null);
});

// --- variables, and what they ship ---

Deno.test("loop: a loop's names are not treated as inputs", async () => {
	// Would throw from assertDeclared if a name reached it.
	const { js } = await generate(`<my-widget b-attr:xs b-generate="render"><li b-for="x, i in xs" b-key="x.id" :title="x.name + i">{{ i }}</li></my-widget>`);
	assertEquals(evalModule(js!, 'my-widget').bfAttrs, { xs: 'string' });
});

Deno.test("loop: nested loops' names and a set's condition on them are not treated as inputs", async () => {
	const { js } = await generate(`<my-widget b-attr:rows b-generate="render"><div b-for="r, i in rows" b-key="i"><p b-for="c in r.cells" b-key="c.id"><b b-if="c.on == r.on">{{ c.id + i }}</b></p></div></my-widget>`);
	assertEquals(evalModule(js!, 'my-widget').bfAttrs, { rows: 'string' });
});

Deno.test("loop: a loop name does not count as reading a store of the same name", async () => {
	const file = await compile(`<my-widget b-attr:xs b-generate="render"><li b-for="x in xs" b-key="x">{{ x }}</li></my-widget>`);
	const root = file.partials.get('my-widget') as CustomElementPartialRoot;
	root.stores = [{ name: 'x', src: '@static/x.js' }];
	const { js } = applyDomPatch(file, { bfidGen: makeSequentialBfidGen() }).modules[0];
	assertEquals(js.includes('bfstore_x'), false, js);
	assertEquals(root.stores[0].shipped, undefined);
});

Deno.test("loop: a store read through an iterable, a key or an item's site ships", async () => {
	for (const body of [
		`<li b-for="x in s.data" b-key="x">a</li>`,
		`<li b-for="x in xs" b-key="s.data + x">a</li>`,
		`<li b-for="x in xs" b-key="x">{{ s.data }}</li>`,
	]) {
		const file = await compile(`<my-widget b-attr:xs b-generate="render">${body}</my-widget>`);
		const root = file.partials.get('my-widget') as CustomElementPartialRoot;
		root.stores = [{ name: 's', src: '/s.js' }];
		const { js } = applyDomPatch(file, { bfidGen: makeSequentialBfidGen() }).modules[0];
		assertEquals(root.stores[0].shipped, true, body);
		assertStringIncludes(js, 'bfstore_s');
	}
});

Deno.test("loop: an input read only in a nested item still counts as read", async () => {
	const file = await compile(`<my-widget b-attr:xs b-generate="render"><div b-for="x in xs" b-key="x"><p b-for="y in x" b-key="y">{{ s.data }}</p></div></my-widget>`);
	const root = file.partials.get('my-widget') as CustomElementPartialRoot;
	root.stores = [{ name: 's', src: '/s.js' }];
	applyDomPatch(file, { bfidGen: makeSequentialBfidGen() });
	assertEquals(root.stores[0].shipped, true);
});

Deno.test("loop: a variable that is neither an input nor a loop name fails the declared check", async () => {
	const file = await compile(`<my-widget b-attr:xs b-generate="render"><li b-for="x in xs" b-key="x">{{ nope }}</li></my-widget>`);
	let message = '';
	try {
		applyDomPatch(file, { bfidGen: makeSequentialBfidGen() });
	} catch (e) {
		message = String(e);
	}
	assertStringIncludes(message, 'nope');
});

// --- the snapshot's const order ---

Deno.test("loop: each const comes after the consts it names", async () => {
	const { js } = await generate(`<my-widget b-attr:rows b-generate="render"><div b-if="rows"><div b-for="r in rows" b-key="r.id"><b b-if="r.on"><p b-for="c in r.cells" b-key="c">a</p></b></div></div></my-widget>`);
	// evalModule would throw on a const used before it is defined.
	const { bfRoot } = evalModule(js!, 'my-widget');
	assertEquals(bfRoot.sets.length, 1);
});
