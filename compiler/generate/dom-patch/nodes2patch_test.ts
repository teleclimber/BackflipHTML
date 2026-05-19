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
	const { js } = applyDomPatch(file, gen);
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
	applyDomPatch(file, gen);

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
	const { js } = applyDomPatch(file, makeSequentialBfidGen());
	assertEquals(js, null);
});

Deno.test("end-to-end: live var declared but never used => no class", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:unused>static</my-widget>`
	);
	const { js } = applyDomPatch(file, makeSequentialBfidGen());
	assertEquals(js, null);
});

Deno.test("end-to-end: attr mixing live and non-live var => skipped, no class", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:title><span :data-x="title + other">hi</span></my-widget>`
	);
	const { js } = applyDomPatch(file, makeSequentialBfidGen());
	assertEquals(js, null);
});

Deno.test("end-to-end: attr inside b-for is skipped (v1 limitation)", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:title><ul><li b-for="item in items" :data-x="title">x</li></ul></my-widget>`
	);
	const { js } = applyDomPatch(file, makeSequentialBfidGen());
	// b-for is skipped (the for body contains other vars too like `items`/`item`).
	// In this scenario the only attr site with `title` is inside the for, so no class.
	assertEquals(js, null);
});

Deno.test("end-to-end: bool b-attr produces hasAttribute in collectData", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:open.bool><div :hidden="open">x</div></my-widget>`
	);
	const { js } = applyDomPatch(file, makeSequentialBfidGen());
	if (!js) throw new Error('expected js');
	assertEquals(js.includes("open: this.ce.hasAttribute('open')"), true);
	// Bool dynamic attr uses set/remove
	assertEquals(js.includes("removeAttribute('hidden')"), true);
});

Deno.test("end-to-end: emits valid JavaScript", async () => {
	const file = await compileCustomElement(
		`<my-widget b-attr:title b-attr:flag.bool><span :data-x="title" :hidden="flag">hi</span></my-widget>`
	);
	const { js } = applyDomPatch(file, makeSequentialBfidGen());
	if (!js) throw new Error('expected js');
	const fn = new Function(js + '; return BackflipMyWidget;');
	const Cls = fn();
	assertEquals(typeof Cls, 'function');
});
