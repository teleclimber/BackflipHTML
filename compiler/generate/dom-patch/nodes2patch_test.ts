import { assertEquals, assertThrows } from "jsr:@std/assert";

import { compilePartial } from "../../compiler.ts";
import type { CompiledFile, ElementTNode, PartialDef } from "../../types.ts";
import { makeSequentialBfidGen } from "./bfid.ts";
import { applyDomPatch, type DomPatchOptions } from "./nodes2patch.ts";
import { evalModule, plain } from "./test-helpers.ts";

async function compileCustomElement(html: string): Promise<CompiledFile> {
	const m = html.match(/<([a-z][a-z0-9-]*-[a-z0-9-]*)/);
	if (!m) throw new Error('test html must start with a custom-element tag');
	// These tests are about what the patch generator produces, not about the directive
	// that asks for it, so a fixture that names no mode gets the one whose output is
	// the patch classes alone. b-generate itself is covered in compiler_test.ts.
	if (!/\bb-generate=/.test(html)) html = html.replace(/^(\s*<[a-z0-9-]+)/, '$1 b-generate="render"');
	const def: PartialDef = {
		name: m[1],
		exported: false,
		customElement: true,
		loc: { filename: '', from: 1, to: 1 },
	};
	const { compiled, errors } = await compilePartial(html, def);
	// Warnings are diagnostics, not failures: b-generate="render" with no b-script warns
	// that nothing would load the module, which is irrelevant to generation itself.
	const fatal = errors.filter(e => e.severity !== 'warning');
	if (fatal.length > 0) throw new Error('compile errors: ' + fatal.map(e => e.message).join(', '));
	return { partials: new Map([[def.name, compiled]]) };
}

// One partial per fixture is the norm here, so unwrap its module.
function domPatch(file: CompiledFile, opts?: DomPatchOptions): { js: string | null } {
	const { modules } = applyDomPatch(file, opts);
	if (modules.length === 0) return { js: null };
	if (modules.length > 1) throw new Error(`expected one module, got ${modules.length}; use applyDomPatch directly`);
	return { js: modules[0].js };
}

// The root descriptor's sites and sets with expressions made comparable (see `plain`).
function rootOf(js: string, partialName: string, sample: Record<string, unknown> = {}) {
	return plain(evalModule(js, partialName).bfRoot, sample);
}

// Assemble several single-partial sources into one CompiledFile, mirroring a
// template file that defines multiple custom elements. dom-patch codegen reads
// only lower-time data (bAttrs, callerAttrs), so no cross-partial linking is
// needed for these tests.
async function compileCustomElements(...htmls: string[]): Promise<CompiledFile> {
	const partials: CompiledFile['partials'] = new Map();
	for (const html of htmls) {
		const single = await compileCustomElement(html);
		for (const [name, root] of single.partials) partials.set(name, root);
	}
	return { partials };
}

Deno.test("end-to-end: simple custom element with one live attr", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:title><span :data-x="title">hi</span></my-widget>`
	);
	const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js');
	assertEquals(js.includes("import { BackflipShell } from './runtime/dom-patch/patch.js';"), true);
	assertEquals(evalModule(js, 'my-widget').bfAttrs, { title: 'string' });
	assertEquals(rootOf(js, 'my-widget', { title: 'T' }), {
		sites: [{ bfid: 'bf0', attr: 'data-x', expr: { vars: ['title'], value: 'T' } }],
		sets: [],
	});
});

Deno.test("end-to-end: data-bfid attr appended to mutated element", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:title><span :data-x="title">hi</span></my-widget>`
	);
	const gen = makeSequentialBfidGen();
	applyDomPatch(file, { bfidGen: gen });

	const root = file.partials.get('my-widget')!;
	// Find the span element in the tree.
	function findElement(tnodes: any[]): ElementTNode | null {
		for (const n of tnodes) {
			if (n.type === 'element' && n.tagName === 'span') return n;
			if (n.type === 'element') {
				const got = findElement(n.tnodes);
				if (got) return got;
			}
		}
		return null;
	}
	const span = findElement(root.tnodes);
	if (!span) throw new Error('span not found');
	const hasBfid = span.attrs.some(a => a.type === 'static' && a.raw.includes('data-bfid="bf0"'));
	assertEquals(hasBfid, true);
});

Deno.test("end-to-end: no live vars => no class produced", async () => {
	const file = await compileCustomElement(
		`<my-widget><span :data-x="someVar">hi</span></my-widget>`
	);
	const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	assertEquals(js, null);
});

Deno.test("end-to-end: live var declared but never used => no class", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:unused>static</my-widget>`
	);
	const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	assertEquals(js, null);
});

Deno.test("end-to-end: attr inside b-for is skipped (v1 limitation)", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:title><ul><li b-for="item in items" :data-x="title">x</li></ul></my-widget>`
	);
	const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	// b-for is skipped (the for body contains other vars too like `items`/`item`).
	// In this scenario the only attr site with `title` is inside the for, so no class.
	assertEquals(js, null);
});

Deno.test("end-to-end: a bool b-attr is declared bool, and a bool attr site is marked bool", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:open.bool><div :hidden="open">x</div></my-widget>`
	);
	const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js');
	assertEquals(evalModule(js, 'my-widget').bfAttrs, { open: 'bool' });
	assertEquals(rootOf(js, 'my-widget').sites[0].bool, true);
});

Deno.test("end-to-end: emits valid JavaScript", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:title b-attr:flag.bool><span :data-x="title" :hidden="flag">hi</span></my-widget>`
	);
	const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js');
	assertEquals(typeof evalModule(js, 'my-widget').shell, 'function');
});

Deno.test("end-to-end: dynamic attr on the definition's wrapping tag targets the element itself", async () => {
	const file = await compileCustomElement(
		`<my-element b-attr:flag.bool :class="flag ? 'yes' : 'no'">x</my-element>`
	);
	const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js (dynamic attr on definition root should be patchable)');
	// bfid null: the target is the custom element, found with no lookup. A string
	// class expression, not a bool attr.
	assertEquals(rootOf(js, 'my-element', { flag: true }).sites,
		[{ bfid: null, attr: 'class', expr: { vars: ['flag'], value: 'yes' } }]);
	assertEquals(evalModule(js, 'my-element').bfAttrs, { flag: 'bool' });
});

Deno.test("end-to-end: bool dynamic attr on definition root is a bool site on the element", async () => {
	const file = await compileCustomElement(
		`<my-thing b-attr:on.bool :hidden="!on">x</my-thing>`
	);
	const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js');
	assertEquals(rootOf(js, 'my-thing', { on: true }).sites,
		[{ bfid: null, attr: 'hidden', bool: true, expr: { vars: ['on'], value: false } }]);
});

Deno.test("end-to-end: live var passed to a nested custom-element call is patchable", async () => {
	const file = await compileCustomElement(
		`<parent-el b-attr:show><child-el desc="hi" :show="show"></child-el></parent-el>`
	);
	const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js (caller attr driven by a live var should be patchable)');
	// The nested custom element is located via a stamped data-bfid, and its `show`
	// attribute is set from the live var.
	assertEquals(rootOf(js, 'parent-el', { show: 'x' }).sites,
		[{ bfid: 'bf0', attr: 'show', expr: { vars: ['show'], value: 'x' } }]);
});

Deno.test("end-to-end: bool caller attr on a nested custom-element call is a bool site", async () => {
	// `open` is a known boolean HTML attribute, so `:open="open"` is a boolean bind.
	const file = await compileCustomElement(
		`<parent-el b-attr:open.bool><child-el :open="open"></child-el></parent-el>`
	);
	const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js');
	assertEquals(rootOf(js, 'parent-el').sites[0].bool, true);
	assertEquals(rootOf(js, 'parent-el').sites[0].attr, 'open');
});

// The user-reported bug: two dom-patchable custom-element partials in the same
// file. The parent's only live-var use is a caller attr on the nested call; before
// caller-attr sites were patchable it produced no class and vanished from the file.
Deno.test("end-to-end: two custom elements in one file each get their own module", async () => {
	const file = await compileCustomElements(
		`<parent-el b-attr:show><child-el :show="show"></child-el></parent-el>`,
		`<child-el b-attr:show><span :data-x="show">x</span></child-el>`,
	);
	const { modules } = applyDomPatch(file, { bfidGen: makeSequentialBfidGen() });
	assertEquals(modules.map(m => m.tagName), ['parent-el', 'child-el']);
	assertEquals(modules[0].js.includes('export class BackflipParentEl'), true);
	assertEquals(modules[0].js.includes('BackflipChildEl'), false);
	assertEquals(modules[1].js.includes('export class BackflipChildEl'), true);
});

// Two unrelated partials in one file. Everything each one generates — class names,
// bfids, marker ids, if-set symbols — has to stay distinct, since they share a file
// (and one bfid generator).
Deno.test("end-to-end: two independent custom elements in one file keep distinct bfids", async () => {
	const file = await compileCustomElements(
		`<first-el b-attr:title><span :data-x="title">{{ title }}</span></first-el>`,
		`<second-el b-attr:label><span :data-y="label">{{ label }}</span></second-el>`,
	);
	const { modules } = applyDomPatch(file, { bfidGen: makeSequentialBfidGen() });
	assertEquals(modules.length, 2);
	// Each partial keeps its own element lookup, print markers and expressions.
	assertEquals(rootOf(modules[0].js, 'first-el', { title: 'T' }).sites, [
		{ bfid: 'bf0', attr: 'data-x', expr: { vars: ['title'], value: 'T' } },
		{ bfid: 'bf0', markers: ['bfid:bf1', 'bfid:bf2'], expr: { vars: ['title'], value: 'T' } },
	]);
	assertEquals(rootOf(modules[1].js, 'second-el', { label: 'L' }).sites, [
		{ bfid: 'bf3', attr: 'data-y', expr: { vars: ['label'], value: 'L' } },
		{ bfid: 'bf3', markers: ['bfid:bf4', 'bfid:bf5'], expr: { vars: ['label'], value: 'L' } },
	]);
	// The two partials share one bfid generator, so no id is reused across the modules.
	const js = modules.map(m => m.js).join('\n');
	const ids = [...js.matchAll(/bf\d+/g)].map(m => m[0]);
	assertEquals(new Set(ids).size, 6);
});

// Two if-sets in one file: their module-level snapshots, branch fns and nested
// patch-branch classes are all keyed off the set id, so the ids must not collide.
Deno.test("end-to-end: two custom elements with b-if sets in one file keep distinct set symbols", async () => {
	const file = await compileCustomElements(
		`<first-el b-attr:flag.bool><p b-if="flag">{{ flag }}</p><p b-else>n</p></first-el>`,
		`<second-el b-attr:on.bool><em b-if="on">y</em><em b-else>n</em></second-el>`,
	);
	const { modules } = applyDomPatch(file, { bfidGen: makeSequentialBfidGen() });
	assertEquals(modules.length, 2);
	const setIds: string[] = [];
	for (const [m, name] of [[modules[0], 'first-el'], [modules[1], 'second-el']] as const) {
		const { bfRoot, defined } = evalModule(m.js, name);
		const id = bfRoot.sets[0].markers[0].replace('bfid:', '');
		setIds.push(id);
		// Each set's descriptor points at its own module-level snapshot.
		assertEquals(bfRoot.sets[0].snapshot, defined[`bfif_${id}`]);
	}
	assertEquals(new Set(setIds).size, 2);
});

Deno.test("end-to-end: nested custom-element call gets a data-bfid stamped into its callerAttrs", async () => {
	const file = await compileCustomElement(
		`<parent-el b-attr:show><child-el :show="show"></child-el></parent-el>`
	);
	applyDomPatch(file, { bfidGen: makeSequentialBfidGen() });
	const root = file.partials.get('parent-el')!;
	function findCall(tnodes: any[]): any {
		for (const n of tnodes) {
			if (n.type === 'partial-ref' && n.kind === 'custom-element') return n;
			if (n.tnodes) { const g = findCall(n.tnodes); if (g) return g; }
		}
		return null;
	}
	const call = findCall(root.tnodes);
	if (!call) throw new Error('nested custom-element call not found');
	const hasBfid = call.callerAttrs.some((a: any) => a.type === 'static' && a.raw.includes('data-bfid="bf0"'));
	assertEquals(hasBfid, true);
});

Deno.test("end-to-end: two live caller attrs on one nested call share a single bfid", async () => {
	const file = await compileCustomElement(
		`<parent-el b-attr:a b-attr:b><child-el :data-a="a" :data-b="b"></child-el></parent-el>`
	);
	const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js');
	assertEquals(rootOf(js, 'parent-el', { a: 1, b: 2 }).sites, [
		{ bfid: 'bf0', attr: 'data-a', expr: { vars: ['a'], value: 1 } },
		{ bfid: 'bf0', attr: 'data-b', expr: { vars: ['b'], value: 2 } },
	]);
});

Deno.test("end-to-end: caller-attr patch emits valid JavaScript", async () => {
	const file = await compileCustomElement(
		`<parent-el b-attr:show><child-el :show="show"></child-el></parent-el>`
	);
	const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js');
	assertEquals(typeof evalModule(js, 'parent-el').shell, 'function');
});

// Recursively collect every comment node's text from a tree.
function collectComments(tnodes: any[]): string[] {
	const out: string[] = [];
	for (const n of tnodes) {
		if (n.type === 'comment') out.push(n.text);
		if (n.type === 'element' || n.type === 'for') out.push(...collectComments(n.tnodes));
		if (n.type === 'if') for (const b of n.branches) out.push(...collectComments(b.tnodes));
	}
	return out;
}

Deno.test("end-to-end: print of a live var wraps it in marker comments and patches it", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:name><p>Hello {{ name }}!</p></my-widget>`
	);
	const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js');

	// AST: the print is bracketed by two marker comments inside the <p>.
	const root = file.partials.get('my-widget')!;
	assertEquals(collectComments(root.tnodes), ['bfid:bf1', 'bfid:bf2']);
	// The descriptor names the <p> and the same two markers.
	assertEquals(rootOf(js, 'my-widget', { name: 'N' }).sites,
		[{ bfid: 'bf0', markers: ['bfid:bf1', 'bfid:bf2'], expr: { vars: ['name'], value: 'N' } }]);
});

Deno.test("end-to-end: print directly in the custom element targets the element itself", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:name>{{ name }}</my-widget>`
	);
	const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js');

	// Markers sit directly in the root; no parent bfid is allocated.
	const root = file.partials.get('my-widget')!;
	assertEquals(collectComments(root.tnodes), ['bfid:bf0', 'bfid:bf1']);
	assertEquals(rootOf(js, 'my-widget').sites[0].bfid, null);
	assertEquals(rootOf(js, 'my-widget').sites[0].markers, ['bfid:bf0', 'bfid:bf1']);
});

// Compile several custom-element partials into a single CompiledFile.
async function compileMany(htmls: string[]): Promise<CompiledFile> {
	const partials = new Map();
	for (const html of htmls) {
		const m = html.match(/<([a-z][a-z0-9-]*-[a-z0-9-]*)/);
		if (!m) throw new Error('test html must start with a custom-element tag');
		const def: PartialDef = { name: m[1], exported: false, customElement: true, loc: { filename: '', from: 1, to: 1 } };
		const withMode = /\bb-generate=/.test(html) ? html : html.replace(/^(\s*<[a-z0-9-]+)/, '$1 b-generate="render"');
		const { compiled, errors } = await compilePartial(withMode, def);
		const fatal = errors.filter(e => e.severity !== 'warning');
		if (fatal.length > 0) throw new Error('compile errors: ' + fatal.map(e => e.message).join(', '));
		partials.set(def.name, compiled);
	}
	return { partials };
}

Deno.test("scripts: dependency added only on partials that produce a module (class-less sibling untouched)", async () => {
	const file = await compileMany([
		`<reactive-widget b-attr:title><span :data-x="title">hi</span></reactive-widget>`,
		`<static-widget><span>hi</span></static-widget>`,
	]);
	const { modules } = applyDomPatch(file, {
		bfidGen: makeSequentialBfidGen(),
		scriptUrlFor: tag => `/bfdom/${tag}.js`,
	});
	assertEquals(modules.map(m => m.tagName), ['reactive-widget']);
	assertEquals((file.partials.get('reactive-widget') as any).scripts, [{ url: '/bfdom/reactive-widget.js', kind: 'dependency' }]);
	// Shares the file with a reactive partial but generates nothing → no dependency.
	assertEquals((file.partials.get('static-widget') as any).scripts, undefined);
});

Deno.test("scripts: b-generate=\"full\" stamps an entry, not a dependency", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:title b-generate="full"><span :data-x="title">hi</span></my-widget>`
	);
	applyDomPatch(file, { bfidGen: makeSequentialBfidGen(), scriptUrlFor: tag => `/bfdom/${tag}.js` });
	assertEquals((file.partials.get('my-widget') as any).scripts, [{ url: '/bfdom/my-widget.js', kind: 'entry' }]);
});

Deno.test("scripts: absent option leaves partials untouched and does not change js", async () => {
	const html = `<my-widget b-attr:title><span :data-x="title">hi</span></my-widget>`;
	const withFile = await compileCustomElement(html);
	const withUrl = applyDomPatch(withFile, { bfidGen: makeSequentialBfidGen(), scriptUrlFor: () => '/bfdom/my-widget.js' });
	const withoutFile = await compileCustomElement(html);
	const without = applyDomPatch(withoutFile, { bfidGen: makeSequentialBfidGen() });
	assertEquals(withUrl.modules[0].js, without.modules[0].js);  // recording the dependency does not affect generated js
	assertEquals((withFile.partials.get('my-widget') as any).scripts, [{ url: '/bfdom/my-widget.js', kind: 'dependency' }]);
	assertEquals((withoutFile.partials.get('my-widget') as any).scripts, undefined);
});

Deno.test("end-to-end: definition-root attr does NOT cause a data-bfid to be appended", async () => {
	const file = await compileCustomElement(
		`<my-element b-attr:flag.bool :class="flag ? 'yes' : 'no'">x</my-element>`
	);
	applyDomPatch(file, { bfidGen: makeSequentialBfidGen() });
	const root = file.partials.get('my-element')!;
	if (root.kind !== 'custom-element') throw new Error('expected custom-element root');
	const defAttrs = root.definitionAttrs ?? [];
	const anyBfid = defAttrs.some(a => a.type === 'static' && a.raw.includes('data-bfid'));
	assertEquals(anyBfid, false);
});

// --- if-sets ---------------------------------------------------------------

Deno.test("end-to-end: an if-set is bracketed by markers and its parent gets a bfid", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:mode><div><p b-if="mode == 'a'">A</p><em b-else>B</em></div></my-widget>`
	);
	const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js');

	// Markers bracket the whole set (one pair, not one per branch), inside the <div>.
	const root = file.partials.get('my-widget')!;
	assertEquals(collectComments(root.tnodes), ['bfid:bf1', 'bfid:bf2']);
	// The <div> is the nearest enclosing element, so it anchors the lookup.
	const div = root.tnodes.find((n: any) => n.type === 'element') as ElementTNode;
	assertEquals(div.attrs.some(a => a.type === 'static' && a.raw.includes('data-bfid="bf0"')), true);

	const { bfRoot, defined } = evalModule(js, 'my-widget');
	assertEquals(bfRoot.sets.length, 1);
	const set = bfRoot.sets[0];
	assertEquals([set.bfid, set.markers, set.subtreeVars, set.branches], ['bf0', ['bfid:bf1', 'bfid:bf2'], [], [null, null]]);
	assertEquals(set.snapshot, defined.bfif_bf1);
});

// The module-level `bfif_*` consts, in emitted order, each with its literal text.
// Each runs from its `const` line to the blank line or next `const` that follows it.
function snapshotConsts(js: string): { name: string, text: string }[] {
	return [...js.matchAll(/^const (bfif_\w+) = ([\s\S]*?);\n(?=const |\n)/gm)]
		.map(m => ({ name: m[1], text: m[2] }));
}

// Evaluate the module and return its `bfif_*` consts by name.
function evalSnapshots(js: string, partialName = 'my-widget'): Record<string, any> {
	return evalModule(js, partialName).defined;
}

Deno.test("end-to-end: a nested set's snapshot is referenced by name, not copied", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:mode b-attr:sub><div b-if="mode == 'a'"><p b-if="sub == 'x'">X</p><em b-else>Y</em></div><span b-else>B</span></my-widget>`
	);
	const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js');
	const consts = snapshotConsts(js);
	assertEquals(consts.length, 2);
	// Innermost first, so the name is defined before the outer literal uses it.
	const [inner, outer] = consts;
	assertEquals(inner.text.includes('<p'), true);
	assertEquals(outer.text.includes('<span>'), true);
	assertEquals(outer.text.includes(inner.name), true);
	// The inner branch content is emitted once, in the inner const only.
	assertEquals(outer.text.includes('<p'), false);
	assertEquals(js.split("raw: 'X'").length - 1, 1);

	// Evaluated, the outer branch holds the inner snapshot object itself.
	const snaps = evalSnapshots(js);
	const outerNodes = snaps[outer.name].branches[0].nodes;
	assertEquals(outerNodes.includes(snaps[inner.name]), true);
});

Deno.test("end-to-end: three nested sets each reference only the set directly inside", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:a b-attr:b b-attr:c>` +
		`<div b-if="a"><section b-if="b"><p b-if="c">deep</p><em b-else>n</em></section><i b-else>n</i></div><span b-else>n</span>` +
		`</my-widget>`
	);
	const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js');
	const consts = snapshotConsts(js);
	assertEquals(consts.length, 3);
	const [c, b, a] = consts;
	assertEquals(c.text.includes('deep'), true);
	assertEquals(b.text.includes(c.name) && !b.text.includes('deep'), true);
	assertEquals(a.text.includes(b.name) && !a.text.includes(c.name) && !a.text.includes('deep'), true);
	assertEquals(js.split("'deep'").length - 1, 1);

	const snaps = evalSnapshots(js);
	assertEquals(snaps[a.name].branches[0].nodes.includes(snaps[b.name]), true);
	assertEquals(snaps[b.name].branches[0].nodes.includes(snaps[c.name]), true);
});

Deno.test("end-to-end: a var-free nested b-if has no const and stays inline", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:mode><div b-if="mode == 'a'"><p b-if="1 == 1">always</p></div><span b-else>B</span></my-widget>`
	);
	const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js');
	const consts = snapshotConsts(js);
	assertEquals(consts.length, 1);
	assertEquals(consts[0].text.includes('always'), true);
});

Deno.test("end-to-end: an if-set directly in the custom element targets the element itself", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:mode><p b-if="mode == 'a'">A</p><em b-else>B</em></my-widget>`
	);
	const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js');
	const root = file.partials.get('my-widget')!;
	assertEquals(collectComments(root.tnodes), ['bfid:bf0', 'bfid:bf1']);
	assertEquals(evalModule(js, 'my-widget').bfRoot.sets[0].bfid, null);
});

Deno.test("end-to-end: the if-set snapshot is taken after pass-1 markers are added", async () => {
	// Ordering regression: the snapshot must carry the data-bfid and print markers
	// added while collecting attr/print sites, or a client-rendered branch would
	// drop the anchors the server-rendered HTML has and stop being patchable.
	const file = await compileCustomElement(
		`<my-widget b-attr:mode b-attr:name><div b-if="mode == 'a'"><p :title="name">Hi {{ name }}</p></div><em b-else>B</em></my-widget>`
	);
	const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js');

	const snapshot = snapshotConsts(js)[0].text;
	const [attrSite, printSite] = evalModule(js, 'my-widget').bfRoot.sets[0].branches[0].sites;
	// The <p>'s bfid (what the attr site patches) is inside the snapshot...
	assertEquals(snapshot.includes(`data-bfid="${attrSite.bfid}"`), true);
	// ...as are the print's marker comments.
	for (const marker of printSite.markers) {
		assertEquals(snapshot.includes(`{ type: 'comment', text: '${marker}' }`), true);
	}
});

Deno.test("end-to-end: a render-mode module imports only BackflipShell", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:title><span :data-x="title">hi {{ title }}</span><p b-if="title">t</p></my-widget>`
	);
	const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	assertEquals([...js!.matchAll(/^import .*$/gm)].map(m => m[0]),
		["import { BackflipShell } from './runtime/dom-patch/patch.js';"]);
});

Deno.test("end-to-end: base and full modules also import BackflipElement", async () => {
	for (const mode of ['base', 'full']) {
		const file = await compileCustomElement(
			`<my-widget b-attr:title b-generate="${mode}"><span :data-x="title">hi</span></my-widget>`
		);
		const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
		assertEquals([...js!.matchAll(/^import .*$/gm)].map(m => m[0]),
			["import { BackflipShell, BackflipElement } from './runtime/dom-patch/patch.js';"]);
	}
});

Deno.test("end-to-end: disqualified if-sets get no markers and no class", async () => {
	// One case per disqualifier: a partial ref in the subtree, a slot, and a set
	// inside b-for.
	const cases = [
		`<my-widget b-attr:mode><p b-if="mode == 'a'"><other-thing></other-thing></p><em b-else>B</em></my-widget>`,
		`<my-widget b-attr:mode><p b-if="mode == 'a'"><span b-slot></span></p><em b-else>B</em></my-widget>`,
		`<my-widget b-attr:mode><ul><li b-for="i in items"><b b-if="mode == 'a'">A</b></li></ul></my-widget>`,
	];
	for (const html of cases) {
		const file = await compileCustomElement(html);
		const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
		assertEquals(js, null, `expected no class for: ${html}`);
		assertEquals(collectComments(file.partials.get('my-widget')!.tnodes), []);
	}
});

Deno.test("end-to-end: a nested if-set is its own patch-branch (nesting supported)", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:a b-attr:b><p b-if="a"><b b-if="b">{{ b }}</b></p><em b-else>B</em></my-widget>`
	);
	const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js');

	// Three marker pairs in the AST: the outer set, the inner set, and the print
	// inside it. The inner markers are also carried inside the outer's snapshot.
	const comments = collectComments(file.partials.get('my-widget')!.tnodes);
	assertEquals(comments.length, 6);

	// Two module-level snapshots, one per set.
	assertEquals((js.match(/const bfif_/g) ?? []).length, 2);
	// The outer set's first branch owns the inner set, whose first branch owns the print.
	// `b` reaches the inner set because the outer set forwards its subtree vars.
	const outer = evalModule(js, 'my-widget').bfRoot.sets[0];
	assertEquals(outer.subtreeVars, ['b']);
	const inner = outer.branches[0].sets[0];
	assertEquals(outer.branches[1], null);
	assertEquals(plain(inner.branches[0].sites, { b: 'B' }).map((s: any) => s.expr), [{ vars: ['b'], value: 'B' }]);
});

Deno.test("end-to-end: applyDomPatch is idempotent — a second run reuses markers and yields identical JS", async () => {
	// The preview applies dom-patch twice on the same cached AST (once to render the
	// HTML, once to emit the JS). A second run must not splice in a fresh marker pair,
	// or the served JS would key off markers the rendered HTML never had.
	const file = await compileCustomElement(
		`<my-widget b-attr:mode b-attr:name><div><p b-if="mode == 'a'">Hi {{ name }}</p><em b-else>o</em></div></my-widget>`
	);
	const first = applyDomPatch(file, { bfidGen: makeSequentialBfidGen() });
	const commentsAfterFirst = collectComments(file.partials.get('my-widget')!.tnodes);

	// Re-run with a generator that would produce brand-new ids if anything were regenerated.
	const second = applyDomPatch(file, { bfidGen: makeSequentialBfidGen('SECOND') });
	const commentsAfterSecond = collectComments(file.partials.get('my-widget')!.tnodes);

	assertEquals(commentsAfterSecond, commentsAfterFirst);   // no extra markers spliced in
	assertEquals(second.modules[0].js, first.modules[0].js);          // identical generated module
	assertEquals(second.modules[0].js.includes('SECOND'), false);     // nothing regenerated
});

Deno.test("end-to-end: a variable the partial does not declare fails loudly", async () => {
	// The compiler rejects this source before dom-patch ever sees it (see
	// validateGeneratedPartialInputs); this fixture skips that stage. The guard
	// exists so a name that ever slipped through cannot compile into a patch that
	// writes `undefined` into the page.
	const file = await compileCustomElement(
		`<my-widget b-attr:title><span :data-x="title + other">hi</span></my-widget>`
	);
	assertThrows(
		() => domPatch(file, { bfidGen: makeSequentialBfidGen() }),
		Error,
		'not a declared b-attr',
	);
});
