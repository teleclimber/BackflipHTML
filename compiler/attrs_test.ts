import { assertEquals } from "jsr:@std/assert";

import { effectiveAttrNames } from "./attrs.ts";

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
