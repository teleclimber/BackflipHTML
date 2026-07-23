import { assertEquals } from "jsr:@std/assert";

import { compilePartial } from "../../compiler.ts";
import type { CompiledFile, ElementTNode, PartialDef } from "../../types.ts";
import { makeSequentialBfidGen } from "./bfid.ts";
import { applyDomPatch } from "./nodes2patch.ts";

async function compileCustomElement(html: string): Promise<CompiledFile> {
	const m = html.match(/<([a-z][a-z0-9-]*-[a-z0-9-]*)/);
	if (!m) throw new Error('test html must start with a custom-element tag');
	const def: PartialDef = {
		name: m[1],
		exported: false,
		customElement: true,
		loc: { filename: '', from: 1, to: 1 },
	};
	const { compiled, errors } = await compilePartial(html, def);
	if (errors.length > 0) throw new Error('compile errors: ' + errors.map(e => e.message).join(', '));
	return { partials: new Map([[def.name, compiled]]) };
}

Deno.test("end-to-end: simple custom element with one live attr", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:title><span :data-x="title">hi</span></my-widget>`
	);
	const gen = makeSequentialBfidGen();
	const { js } = applyDomPatch(file, { bfidGen: gen });
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
	const { js } = applyDomPatch(file, { bfidGen: makeSequentialBfidGen() });
	assertEquals(js, null);
});

Deno.test("end-to-end: live var declared but never used => no class", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:unused>static</my-widget>`
	);
	const { js } = applyDomPatch(file, { bfidGen: makeSequentialBfidGen() });
	assertEquals(js, null);
});

Deno.test("end-to-end: attr mixing live and non-live var => skipped, no class", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:title><span :data-x="title + other">hi</span></my-widget>`
	);
	const { js } = applyDomPatch(file, { bfidGen: makeSequentialBfidGen() });
	assertEquals(js, null);
});

Deno.test("end-to-end: attr inside b-for is skipped (v1 limitation)", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:title><ul><li b-for="item in items" :data-x="title">x</li></ul></my-widget>`
	);
	const { js } = applyDomPatch(file, { bfidGen: makeSequentialBfidGen() });
	// b-for is skipped (the for body contains other vars too like `items`/`item`).
	// In this scenario the only attr site with `title` is inside the for, so no class.
	assertEquals(js, null);
});

Deno.test("end-to-end: bool b-attr produces hasAttribute in collectData", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:open.bool><div :hidden="open">x</div></my-widget>`
	);
	const { js } = applyDomPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js');
	assertEquals(js.includes("open: this.ce.hasAttribute('open')"), true);
	// Bool dynamic attr uses set/remove
	assertEquals(js.includes("removeAttribute('hidden')"), true);
});

Deno.test("end-to-end: emits valid JavaScript", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:title b-attr:flag.bool><span :data-x="title" :hidden="flag">hi</span></my-widget>`
	);
	const { js } = applyDomPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js');
	const fn = new Function(js.replaceAll('export class', 'class') + '; return BackflipMyWidget;');
	const Cls = fn();
	assertEquals(typeof Cls, 'function');
});

Deno.test("end-to-end: dynamic attr on the definition's wrapping tag targets this.ce", async () => {
	const file = await compileCustomElement(
		`<my-element b-attr:flag.bool :class="flag ? 'yes' : 'no'">x</my-element>`
	);
	const { js } = applyDomPatch(file, { bfidGen: makeSequentialBfidGen() });
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
	const { js } = applyDomPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js');
	assertEquals(js.includes('elem = this.ref_elem;'), true);
	assertEquals(js.includes("elem.setAttribute('hidden', '')"), true);
	assertEquals(js.includes("elem.removeAttribute('hidden')"), true);
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
	const { js } = applyDomPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js');

	// AST: the print is bracketed by two marker comments inside the <p>.
	const root = file.partials.get('my-widget')!;
	assertEquals(collectComments(root.tnodes), ['bfid:bf1', 'bfid:bf2']);

	// Class wires the parent lookup, value fn, mutate, and the child-range helper.
	assertEquals(js.includes('class BackflipMyWidget'), true);
	assertEquals(js.includes('sel_bf0()'), true);
	assertEquals(js.includes('bc_print_bf1(data)'), true);
	assertEquals(js.includes('mutate_name'), true);
	assertEquals(js.includes("this.replaceBetween(elem, 'bfid:bf1', 'bfid:bf2', document.createTextNode(String(this.bc_print_bf1(data))));"), true);
	assertEquals(js.includes('replaceBetween(parent, startMarker, endMarker, node)'), true);
});

Deno.test("end-to-end: print directly in the custom element targets this.ce", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:name>{{ name }}</my-widget>`
	);
	const { js } = applyDomPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js');

	// Markers sit directly in the root; no parent bfid is allocated.
	const root = file.partials.get('my-widget')!;
	assertEquals(collectComments(root.tnodes), ['bfid:bf0', 'bfid:bf1']);
	assertEquals(js.includes('sel_'), false);
	assertEquals(js.includes('querySelector'), false);
	assertEquals(js.includes('elem = this.ref_elem;'), true);
	assertEquals(js.includes("this.replaceBetween(elem, 'bfid:bf0', 'bfid:bf1', document.createTextNode(String(this.bc_print_bf0(data))));"), true);
});

Deno.test("end-to-end: print mixing live and non-live vars => no comments, no class", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:name><p>{{ name + other }}</p></my-widget>`
	);
	const { js } = applyDomPatch(file, { bfidGen: makeSequentialBfidGen() });
	assertEquals(js, null);
	const root = file.partials.get('my-widget')!;
	assertEquals(collectComments(root.tnodes), []);
});

// Compile several custom-element partials into a single CompiledFile.
async function compileMany(htmls: string[]): Promise<CompiledFile> {
	const partials = new Map();
	for (const html of htmls) {
		const m = html.match(/<([a-z][a-z0-9-]*-[a-z0-9-]*)/);
		if (!m) throw new Error('test html must start with a custom-element tag');
		const def: PartialDef = { name: m[1], exported: false, customElement: true, loc: { filename: '', from: 1, to: 1 } };
		const { compiled, errors } = await compilePartial(html, def);
		if (errors.length > 0) throw new Error('compile errors: ' + errors.map(e => e.message).join(', '));
		partials.set(def.name, compiled);
	}
	return { partials };
}

Deno.test("scripts: dependency added only on partials that produce a class (class-less sibling untouched)", async () => {
	const file = await compileMany([
		`<reactive-widget b-attr:title><span :data-x="title">hi</span></reactive-widget>`,
		`<static-widget><span>hi</span></static-widget>`,
	]);
	const { js } = applyDomPatch(file, { bfidGen: makeSequentialBfidGen(), scriptUrl: '/bfdom/widgets.js' });
	if (!js) throw new Error('expected js');
	assertEquals((file.partials.get('reactive-widget') as any).scripts, [{ url: '/bfdom/widgets.js', kind: 'dependency' }]);
	// Shares the file with a reactive partial but produces no class → no dependency.
	assertEquals((file.partials.get('static-widget') as any).scripts, undefined);
});

Deno.test("scripts: absent option leaves partials untouched and does not change js", async () => {
	const html = `<my-widget b-attr:title><span :data-x="title">hi</span></my-widget>`;
	const withFile = await compileCustomElement(html);
	const withUrl = applyDomPatch(withFile, { bfidGen: makeSequentialBfidGen(), scriptUrl: '/bfdom/my-widget.js' });
	const withoutFile = await compileCustomElement(html);
	const without = applyDomPatch(withoutFile, { bfidGen: makeSequentialBfidGen() });
	assertEquals(withUrl.js, without.js);  // recording the dependency does not affect generated js
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
	const { js, needsRender } = applyDomPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js');
	assertEquals(needsRender, true);

	// Markers bracket the whole set (one pair, not one per branch), inside the <div>.
	const root = file.partials.get('my-widget')!;
	assertEquals(collectComments(root.tnodes), ['bfid:bf1', 'bfid:bf2']);
	// The <div> is the nearest enclosing element, so it anchors the lookup.
	const div = root.tnodes.find((n: any) => n.type === 'element') as ElementTNode;
	assertEquals(div.attrs.some(a => a.type === 'static' && a.raw.includes('data-bfid="bf0"')), true);

	assertEquals(js.includes("import { render } from './render.js';"), true);
	assertEquals(js.includes('const bfif_bf1 = '), true);
	assertEquals(js.includes('branch_bf1(data)'), true);
	assertEquals(js.includes('renderIf_bf1(data)'), true);
	assertEquals(js.includes("this.replaceBetween(elem, 'bfid:bf1', 'bfid:bf2', frag);"), true);
	assertEquals(js.includes('this.if_bf1 = this.branch_bf1(data);'), true);
});

Deno.test("end-to-end: an if-set directly in the custom element targets this.ce", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:mode><p b-if="mode == 'a'">A</p><em b-else>B</em></my-widget>`
	);
	const { js } = applyDomPatch(file, { bfidGen: makeSequentialBfidGen() });
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
	const { js } = applyDomPatch(file, { bfidGen: makeSequentialBfidGen() });
	if (!js) throw new Error('expected js');

	const snapshot = js.slice(js.indexOf('const bfif_'), js.indexOf('export class'));
	// The <p>'s bfid (used by mutate_name's setAttribute) is inside the snapshot...
	const bfidMatch = js.match(/sel_(bf\d+)\(\)/)!;
	assertEquals(snapshot.includes(`data-bfid="${bfidMatch[1]}"`), true);
	// ...as are the print's marker comments.
	const printMarkers = js.match(/this\.replaceBetween\(elem, '(bfid:bf\d+)', '(bfid:bf\d+)', document\.createTextNode/)!;
	assertEquals(snapshot.includes(`{ type: 'comment', text: '${printMarkers[1]}' }`), true);
	assertEquals(snapshot.includes(`{ type: 'comment', text: '${printMarkers[2]}' }`), true);
});

Deno.test("end-to-end: renderImportPath option sets the import specifier", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:mode><p b-if="mode == 'a'">A</p><em b-else>B</em></my-widget>`
	);
	const { js } = applyDomPatch(file, { bfidGen: makeSequentialBfidGen(), renderImportPath: '../../render.js' });
	assertEquals(js!.includes("import { render } from '../../render.js';"), true);
});

Deno.test("end-to-end: a partial with no if-set imports nothing and needsRender is false", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:title><span :data-x="title">hi</span></my-widget>`
	);
	const { js, needsRender } = applyDomPatch(file, { bfidGen: makeSequentialBfidGen() });
	assertEquals(needsRender, false);
	assertEquals(js!.includes('import'), false);
});

Deno.test("end-to-end: disqualified if-sets get no markers and no class", async () => {
	// One case per disqualifier: non-live condition var, a partial ref in the
	// subtree, an inner set (which must stay unpatched), and a set inside b-for.
	const cases = [
		`<my-widget b-attr:mode><p b-if="other == 'a'">A</p><em b-else>B</em></my-widget>`,
		`<my-widget b-attr:mode><p b-if="mode == 'a'"><other-thing></other-thing></p><em b-else>B</em></my-widget>`,
		`<my-widget b-attr:mode><p b-if="mode == 'a'"><span b-slot></span></p><em b-else>B</em></my-widget>`,
		`<my-widget b-attr:mode><ul><li b-for="i in items"><b b-if="mode == 'a'">A</b></li></ul></my-widget>`,
	];
	for (const html of cases) {
		const file = await compileCustomElement(html);
		const { js } = applyDomPatch(file, { bfidGen: makeSequentialBfidGen() });
		assertEquals(js, null, `expected no class for: ${html}`);
		assertEquals(collectComments(file.partials.get('my-widget')!.tnodes), []);
	}
});

Deno.test("end-to-end: a nested if-set is its own patch-branch (nesting supported)", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:a b-attr:b><p b-if="a"><b b-if="b">{{ b }}</b></p><em b-else>B</em></my-widget>`
	);
	const { js } = applyDomPatch(file, { bfidGen: makeSequentialBfidGen() });
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
	assertEquals(second.js, first.js);                       // identical generated module
	assertEquals(second.js!.includes('SECOND'), false);      // nothing regenerated
});
