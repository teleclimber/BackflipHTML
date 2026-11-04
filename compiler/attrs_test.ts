import { assertEquals } from "jsr:@std/assert";

import { effectiveAttrNames, isDirectiveAttr } from "./attrs.ts";
import { compileFile } from "./test-helpers.ts";
import type { TNode } from "./types.ts";

// ---- isDirectiveAttr ----

Deno.test("isDirectiveAttr: true for every directive", () => {
	for (const name of [
		'b-name', 'b-export', 'b-if', 'b-for', 'b-key', 'b-else', 'b-else-if', 'b-part', 'b-slot', 'b-in',
		'b-script', 'b-generate', 'b-data:d', 'b-attr:a', 'b-store:s',
	]) {
		assertEquals(isDirectiveAttr(name), true, name);
	}
});

Deno.test("isDirectiveAttr: false for attributes that reach the rendered tag", () => {
	for (const name of ['id', 'class', 'b-unknown', ':title', 'b-bind:title', 'src~', 'data-b-for']) {
		assertEquals(isDirectiveAttr(name), false, name);
	}
});

// ---- a custom element call's two attribute lists ----

Deno.test("custom element call: callerAttrInfos and callerAttrNames agree on which attributes are directives", async () => {
	const directives = [
		'b-key="x"', 'b-script="x"', 'b-generate="full"', 'b-export', 'b-data:d="x"',
		'b-attr:a', 'b-store:s', 'b-in="x"', 'b-for="x in xs"',
	];
	for (const directive of directives) {
		const { compiled } = await compileFile(`<ul b-name="p"><my-card ${directive} id="i" :v="x"></my-card></ul>`);
		const find = (ns: TNode[]): TNode | undefined => {
			for (const n of ns) {
				if (n.type === 'partial-ref') return n;
				if (n.type === 'element' || n.type === 'for') {
					const hit = find(n.tnodes);
					if (hit) return hit;
				}
			}
			return undefined;
		};
		const call = find(compiled.partials.get('p')!.tnodes);
		if (call?.type !== 'partial-ref' || call.kind !== 'custom-element') throw new Error(`no call for ${directive}`);
		assertEquals(call.callerAttrInfos!.map(a => a.name), ['id', 'v'], directive);
		assertEquals(call.callerAttrNames, ['id', 'v'], directive);
	}
});

// ---- effectiveAttrNames unit tests ----

Deno.test("effectiveAttrNames: empty attrs yields empty list", () => {
	assertEquals(effectiveAttrNames([]), []);
});

Deno.test("effectiveAttrNames: plain attributes pass through unchanged", () => {
	assertEquals(
		effectiveAttrNames([{ name: 'class', value: 'foo' }, { name: 'id', value: 'bar' }]),
		['class', 'id']
	);
});

Deno.test("effectiveAttrNames: b-name and b-export are excluded", () => {
	assertEquals(
		effectiveAttrNames([{ name: 'b-name', value: 'x' }, { name: 'b-export', value: '' }, { name: 'class', value: 'c' }]),
		['class']
	);
});

Deno.test("effectiveAttrNames: control-flow directives are excluded", () => {
	assertEquals(
		effectiveAttrNames([
			{ name: 'b-if', value: 'cond' },
			{ name: 'b-for', value: 'x in xs' },
			{ name: 'b-else', value: '' },
			{ name: 'b-else-if', value: 'cond' },
			{ name: 'class', value: 'c' },
		]),
		['class']
	);
});

Deno.test("effectiveAttrNames: partial/slot directives are excluded", () => {
	assertEquals(
		effectiveAttrNames([
			{ name: 'b-part', value: 'foo' },
			{ name: 'b-slot', value: 'name' },
			{ name: 'b-in', value: 'name' },
			{ name: 'class', value: 'c' },
		]),
		['class']
	);
});

Deno.test("effectiveAttrNames: b-data: bindings are excluded", () => {
	assertEquals(
		effectiveAttrNames([
			{ name: 'b-data:name', value: '' },
			{ name: 'b-data:title', value: 'expr' },
			{ name: 'class', value: 'c' },
		]),
		['class']
	);
});

Deno.test("effectiveAttrNames: b-bind:foo resolves to foo", () => {
	assertEquals(
		effectiveAttrNames([{ name: 'b-bind:href', value: 'url' }]),
		['href']
	);
});

Deno.test("effectiveAttrNames: b-bind:foo~ resolves to foo (asset suffix stripped)", () => {
	assertEquals(
		effectiveAttrNames([{ name: 'b-bind:src~', value: 'asset' }]),
		['src']
	);
});

Deno.test("effectiveAttrNames: :foo shorthand resolves to foo", () => {
	assertEquals(
		effectiveAttrNames([{ name: ':href', value: 'url' }]),
		['href']
	);
});

Deno.test("effectiveAttrNames: :foo~ shorthand resolves to foo (asset suffix stripped)", () => {
	assertEquals(
		effectiveAttrNames([{ name: ':src~', value: 'asset' }]),
		['src']
	);
});

Deno.test("effectiveAttrNames: foo~ asset shorthand resolves to foo", () => {
	assertEquals(
		effectiveAttrNames([{ name: 'src~', value: '@images/x.png' }]),
		['src']
	);
});

Deno.test("effectiveAttrNames: mixed attrs preserve order and apply all rules", () => {
	assertEquals(
		effectiveAttrNames([
			{ name: 'b-name', value: 'p' },
			{ name: 'class', value: 'c' },
			{ name: 'b-bind:href', value: 'url' },
			{ name: 'b-data:x', value: '1' },
			{ name: ':title', value: 't' },
			{ name: 'src~', value: '@a.png' },
			{ name: 'b-if', value: 'cond' },
			{ name: 'id', value: 'i' },
		]),
		['class', 'href', 'title', 'src', 'id']
	);
});
