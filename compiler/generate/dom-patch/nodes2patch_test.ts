import { assertEquals, assertThrows } from "jsr:@std/assert";

import { compilePartial } from "../../compiler.ts";
import type { CompiledFile, ElementTNode, PartialDef } from "../../types.ts";
import { makeSequentialBfidGen } from "./bfid.ts";
import { applyDomPatch, type DomPatchOptions, type RuntimeFile } from "./nodes2patch.ts";

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
function domPatch(file: CompiledFile, opts?: DomPatchOptions): { js: string | null, runtimeFiles: RuntimeFile[] } {
	const { modules } = applyDomPatch(file, opts);
	if (modules.length === 0) return { js: null, runtimeFiles: [] };
	if (modules.length > 1) throw new Error(`expected one module, got ${modules.length}; use applyDomPatch directly`);
	return { js: modules[0].js, runtimeFiles: modules[0].runtimeFiles };
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
	const gen = makeSequentialBfidGen();
	const { js } = domPatch(file, { bfidGen: gen });
	if (!js) throw new Error('expected js');

	// Class is present.
	assertEquals(js.includes('class BackflipMyWidget'), true);
	// bc, sel, mutate, collectData all wired.
	assertEquals(js.includes('sel_bf0()'), true);
	assertEquals(js.includes('bc_bf0_data_x'), true);
	assertEquals(js.includes('mutate_title'), true);
	assertEquals(js.includes("getAttribute('title')"), true);
	assertEquals(js.includes("setAttribute('data-x'"), true);
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

Deno.test("end-to-end: bool b-attr produces hasAttribute in collectData", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:open.bool><div :hidden="open">x</div></my-widget>`
	);
	const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js');
	assertEquals(js.includes("open: this.ce.hasAttribute('open')"), true);
	// Bool dynamic attr uses set/remove
	assertEquals(js.includes("removeAttribute('hidden')"), true);
});

Deno.test("end-to-end: emits valid JavaScript", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:title b-attr:flag.bool><span :data-x="title" :hidden="flag">hi</span></my-widget>`
	);
	const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js');
	const fn = new Function(js.replaceAll('export class', 'class') + '; return BackflipMyWidget;');
	const Cls = fn();
	assertEquals(typeof Cls, 'function');
});

Deno.test("end-to-end: dynamic attr on the definition's wrapping tag targets this.ce", async () => {
	const file = await compileCustomElement(
		`<my-element b-attr:flag.bool :class="flag ? 'yes' : 'no'">x</my-element>`
	);
	const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js (dynamic attr on definition root should be patchable)');
	assertEquals(js.includes('class BackflipMyElement'), true);
	assertEquals(js.includes('mutate_flag'), true);
	// No bfid lookup is needed — the patch target is the custom element itself.
	assertEquals(js.includes('sel_'), false);
	assertEquals(js.includes('querySelector'), false);
	assertEquals(js.includes('elem = this.ref_elem;'), true);
	assertEquals(js.includes("elem.setAttribute('class', String(this.bc_ce_class(data)))"), true);
	// The def-root attr is a string class expression, not bool, so no removeAttribute.
	assertEquals(js.includes("removeAttribute('class')"), false);
	// b-attr:flag.bool is bool → collectData uses hasAttribute.
	assertEquals(js.includes("flag: this.ce.hasAttribute('flag')"), true);
});

Deno.test("end-to-end: bool dynamic attr on definition root uses set/remove on elem", async () => {
	const file = await compileCustomElement(
		`<my-thing b-attr:on.bool :hidden="!on">x</my-thing>`
	);
	const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js');
	assertEquals(js.includes('elem = this.ref_elem;'), true);
	assertEquals(js.includes("elem.setAttribute('hidden', '')"), true);
	assertEquals(js.includes("elem.removeAttribute('hidden')"), true);
});

Deno.test("end-to-end: live var passed to a nested custom-element call is patchable", async () => {
	const file = await compileCustomElement(
		`<parent-el b-attr:show><child-el desc="hi" :show="show"></child-el></parent-el>`
	);
	const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js (caller attr driven by a live var should be patchable)');
	assertEquals(js.includes('export class BackflipParentEl'), true);
	assertEquals(js.includes('mutate_show'), true);
	// The nested custom element is located via a stamped data-bfid, and its
	// `show` attribute is set from the live var.
	assertEquals(js.includes('sel_bf0()'), true);
	assertEquals(js.includes("querySelector('[data-bfid=\"bf0\"]')"), true);
	assertEquals(js.includes("setAttribute('show', String(this.bc_bf0_show(data)))"), true);
});

Deno.test("end-to-end: bool caller attr on a nested custom-element call uses set/remove", async () => {
	// `open` is a known boolean HTML attribute, so `:open="open"` is a boolean bind.
	const file = await compileCustomElement(
		`<parent-el b-attr:open.bool><child-el :open="open"></child-el></parent-el>`
	);
	const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js');
	assertEquals(js.includes("setAttribute('open', '')"), true);
	assertEquals(js.includes("removeAttribute('open')"), true);
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
	const js = modules.map(m => m.js).join('\n');
	assertEquals(modules[0].js.includes('export class BackflipFirstEl'), true);
	assertEquals(modules[1].js.includes('export class BackflipSecondEl'), true);
	// Each partial keeps its own element lookup, print markers and expression fns.
	assertEquals(js.match(/sel_bf\d+\(\) \{/g)?.length, 2);
	assertEquals(js.match(/replaceBetween\(elem, '(bfid:bf\d+)'/g)?.length, 2);
	assertEquals(modules[0].js.includes('bc_bf0_data_x'), true);
	assertEquals(modules[1].js.includes('bc_bf3_data_y'), true);
	// The two partials share one bfid generator, so no id is reused across the modules.
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
	for (const m of modules) assertEquals(m.runtimeFiles, ['render.js', 'patch.js']);
	// Each module imports the runtime once for itself.
	for (const m of modules) {
		assertEquals(m.js.match(/^import \{ render, activeBranchIndex \} from/gm)?.length, 1);
		assertEquals(m.js.match(/^import \{ replaceBetween \} from/gm)?.length, 1);
	}
	const js = modules.map(m => m.js).join('\n');
	const setIds = [...js.matchAll(/^const bfif_(bf\d+) = /gm)].map(m => m[1]);
	assertEquals(setIds.length, 2);
	assertEquals(new Set(setIds).size, 2);
	for (const id of setIds) {
		assertEquals(js.includes(`activeBranchIndex(bfif_${id}, data)`), true);
		assertEquals(js.includes(`renderIf_${id}(data) {`), true);
	}
	// Class names are unique across the two modules, nested branch classes included.
	const classNames = [...js.matchAll(/^(?:export )?class (\w+) \{/gm)].map(m => m[1]);
	assertEquals(new Set(classNames).size, classNames.length);
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
	// One data-bfid, one sel_ helper, but both attributes patched off it.
	assertEquals(js.match(/sel_bf\d+\(\) \{/g)?.length, 1);
	assertEquals(js.includes("setAttribute('data-a', String(this.bc_bf0_data_a(data)))"), true);
	assertEquals(js.includes("setAttribute('data-b', String(this.bc_bf0_data_b(data)))"), true);
});

Deno.test("end-to-end: caller-attr patch emits valid JavaScript", async () => {
	const file = await compileCustomElement(
		`<parent-el b-attr:show><child-el :show="show"></child-el></parent-el>`
	);
	const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js');
	const fn = new Function(js.replaceAll('export class', 'class') + '; return BackflipParentEl;');
	assertEquals(typeof fn(), 'function');
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

	// Class wires the parent lookup, value fn, and mutate; the range replace is imported.
	assertEquals(js.includes('class BackflipMyWidget'), true);
	assertEquals(js.includes('sel_bf0()'), true);
	assertEquals(js.includes('bc_print_bf1(data)'), true);
	assertEquals(js.includes('mutate_name'), true);
	assertEquals(js.includes("\treplaceBetween(elem, 'bfid:bf1', 'bfid:bf2', document.createTextNode(String(this.bc_print_bf1(data))));"), true);
	assertEquals(js.includes("import { replaceBetween } from './patch.js';"), true);
	assertEquals(js.includes('replaceBetween(parent'), false);
});

Deno.test("end-to-end: print directly in the custom element targets this.ce", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:name>{{ name }}</my-widget>`
	);
	const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js');

	// Markers sit directly in the root; no parent bfid is allocated.
	const root = file.partials.get('my-widget')!;
	assertEquals(collectComments(root.tnodes), ['bfid:bf0', 'bfid:bf1']);
	assertEquals(js.includes('sel_'), false);
	assertEquals(js.includes('querySelector'), false);
	assertEquals(js.includes('elem = this.ref_elem;'), true);
	assertEquals(js.includes("\treplaceBetween(elem, 'bfid:bf0', 'bfid:bf1', document.createTextNode(String(this.bc_print_bf0(data))));"), true);
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
	const { js, runtimeFiles } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js');
	assertEquals(runtimeFiles, ['render.js', 'patch.js']);

	// Markers bracket the whole set (one pair, not one per branch), inside the <div>.
	const root = file.partials.get('my-widget')!;
	assertEquals(collectComments(root.tnodes), ['bfid:bf1', 'bfid:bf2']);
	// The <div> is the nearest enclosing element, so it anchors the lookup.
	const div = root.tnodes.find((n: any) => n.type === 'element') as ElementTNode;
	assertEquals(div.attrs.some(a => a.type === 'static' && a.raw.includes('data-bfid="bf0"')), true);

	assertEquals(js.includes("import { render, activeBranchIndex } from './render.js';"), true);
	assertEquals(js.includes("import { replaceBetween } from './patch.js';"), true);
	assertEquals(js.includes('const bfif_bf1 = '), true);
	assertEquals(js.includes('renderIf_bf1(data)'), true);
	assertEquals(js.includes("\treplaceBetween(elem, 'bfid:bf1', 'bfid:bf2', frag);"), true);
	assertEquals(js.includes('this.if_bf1 = activeBranchIndex(bfif_bf1, data);'), true);
});

Deno.test("end-to-end: an if-set directly in the custom element targets this.ce", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:mode><p b-if="mode == 'a'">A</p><em b-else>B</em></my-widget>`
	);
	const { js } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js');
	const root = file.partials.get('my-widget')!;
	assertEquals(collectComments(root.tnodes), ['bfid:bf0', 'bfid:bf1']);
	assertEquals(js.includes('const elem = this.ref_elem;'), true);
	assertEquals(js.includes('querySelector'), false);
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

	const snapshot = js.slice(js.indexOf('const bfif_'), js.indexOf('export class'));
	// The <p>'s bfid (used by mutate_name's setAttribute) is inside the snapshot...
	const bfidMatch = js.match(/sel_(bf\d+)\(\)/)!;
	assertEquals(snapshot.includes(`data-bfid="${bfidMatch[1]}"`), true);
	// ...as are the print's marker comments.
	const printMarkers = js.match(/\treplaceBetween\(elem, '(bfid:bf\d+)', '(bfid:bf\d+)', document\.createTextNode/)!;
	assertEquals(snapshot.includes(`{ type: 'comment', text: '${printMarkers[1]}' }`), true);
	assertEquals(snapshot.includes(`{ type: 'comment', text: '${printMarkers[2]}' }`), true);
});

Deno.test("end-to-end: a partial with only attr sites imports nothing", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:title><span :data-x="title">hi</span></my-widget>`
	);
	const { js, runtimeFiles } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	assertEquals(runtimeFiles, []);
	assertEquals(js!.includes('import'), false);
});

Deno.test("end-to-end: a partial with prints but no if-set imports only patch.js", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:title><span>{{ title }}</span></my-widget>`
	);
	const { js, runtimeFiles } = domPatch(file, { bfidGen: makeSequentialBfidGen() });
	assertEquals(runtimeFiles, ['patch.js']);
	assertEquals(js!.includes("import { replaceBetween } from './patch.js';"), true);
	assertEquals(js!.includes('render.js'), false);
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
	// A child patch-branch class is emitted for the branch that owns the inner set.
	assertEquals(/class BackflipPatch_bf\d+_0 \{/.test(js), true);

	// The outer set is driven by `a`; the inner set (owned by the child branch) by `b`.
	// `b` reaches the inner set by forwarding from the root's subtree var down to the
	// active child, so both vars appear in an update switch somewhere.
	assertEquals(js.includes("case 'a': this.mutate_a(data); break;"), true);
	assertEquals(js.includes("case 'b': this.mutate_b(data); break;"), true);
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
