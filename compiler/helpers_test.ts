import { assertEquals } from "jsr:@std/assert";

import type { RawTNode, TNode, PartialDef } from "./types.ts";
import type { SourceNode, SourceText } from "./parse-tree.ts";
import { collectSlots, isCustomElementTagName, parseBForValue, parseBPartValue } from "./helpers.ts";
import { lowerSlice } from "./lower.ts";
import { interpretBackcode } from "./backcode.ts";

// ---- isCustomElementTagName unit tests ----

Deno.test("isCustomElementTagName: empty string is not a custom element", () => {
	assertEquals(isCustomElementTagName(''), false);
});

Deno.test("isCustomElementTagName: plain HTML tag without hyphen is not a custom element", () => {
	assertEquals(isCustomElementTagName('div'), false);
	assertEquals(isCustomElementTagName('span'), false);
	assertEquals(isCustomElementTagName('h1'), false);
});

Deno.test("isCustomElementTagName: hyphenated lowercase tag is a custom element", () => {
	assertEquals(isCustomElementTagName('my-element'), true);
	assertEquals(isCustomElementTagName('app-header'), true);
	assertEquals(isCustomElementTagName('a-b-c'), true);
});

Deno.test("isCustomElementTagName: backflip directive tags (b-*) are excluded", () => {
	assertEquals(isCustomElementTagName('b-name'), false);
	assertEquals(isCustomElementTagName('b-unwrap'), false);
	assertEquals(isCustomElementTagName('b-foo'), false);
});

Deno.test("isCustomElementTagName: must start with a lowercase letter", () => {
	assertEquals(isCustomElementTagName('My-Element'), false);
	assertEquals(isCustomElementTagName('1my-element'), false);
	assertEquals(isCustomElementTagName('-my-element'), false);
});

Deno.test("isCustomElementTagName: hyphen is required", () => {
	assertEquals(isCustomElementTagName('myelement'), false);
});

Deno.test("isCustomElementTagName: digits allowed after the leading letter", () => {
	assertEquals(isCustomElementTagName('h1-header'), true);
	assertEquals(isCustomElementTagName('foo2-bar'), true);
});

// ---- parseBPartValue unit tests ----

Deno.test("parseBPartValue: same-file reference with #", () => {
	assertEquals(parseBPartValue('#header'), { partialName: 'header', file: null });
});

Deno.test("parseBPartValue: cross-file reference", () => {
	assertEquals(parseBPartValue('components.html#header'), { partialName: 'header', file: 'components.html' });
});

Deno.test("parseBPartValue: cross-file reference with subdirectory path", () => {
	assertEquals(parseBPartValue('path/to/file.html#card'), { partialName: 'card', file: 'path/to/file.html' });
});

Deno.test("parseBPartValue: bare name is same-file reference", () => {
	assertEquals(parseBPartValue('header'), { partialName: 'header', file: null });
});

Deno.test("parseBPartValue: empty string", () => {
	assertEquals(parseBPartValue(''), { partialName: '', file: null });
});

// ---- parseBForValue unit tests ----

function bfor(value: string) {
	const r = parseBForValue(value);
	return 'error' in r ? r : { valName: r.valName, indexName: r.indexName, vars: r.iterable.vars };
}

Deno.test("parseBForValue: value only", () => {
	assertEquals(bfor('item in items'), { valName: 'item', indexName: undefined, vars: ['items'] });
});

Deno.test("parseBForValue: value and index", () => {
	assertEquals(bfor('m, i in meters'), { valName: 'm', indexName: 'i', vars: ['meters'] });
});

Deno.test("parseBForValue: value and index in parentheses", () => {
	assertEquals(bfor('(m, i) in meters'), { valName: 'm', indexName: 'i', vars: ['meters'] });
});

Deno.test("parseBForValue: value alone in parentheses", () => {
	assertEquals(bfor('(m) in meters'), { valName: 'm', indexName: undefined, vars: ['meters'] });
});

Deno.test("parseBForValue: extra whitespace is allowed", () => {
	assertEquals(bfor('  ( m ,  i )   in   meters  '), { valName: 'm', indexName: 'i', vars: ['meters'] });
	assertEquals(bfor('m,i in meters'), { valName: 'm', indexName: 'i', vars: ['meters'] });
});

Deno.test("parseBForValue: ' in ' inside the iterable expression stays in the iterable", () => {
	const r = parseBForValue("x in flag ? a : 'b in c'");
	if ('error' in r) throw new Error(r.error);
	assertEquals(r.valName, 'x');
	assertEquals(r.iterable.errs, []);
	assertEquals(r.iterable.vars, ['flag', 'a']);
});

Deno.test("parseBForValue: missing 'in' or too many names is a form error", () => {
	for (const v of ['items', 'm, i of meters', 'item in', 'item in   ', 'm, i, j in items']) {
		const r = parseBForValue(v);
		assertEquals('error' in r && r.error.startsWith('b-for value must be in the form'), true, v);
	}
});

Deno.test("parseBForValue: unbalanced or misplaced parentheses are form errors", () => {
	for (const v of ['(m, i in meters', 'm, i) in meters', '(m)(i) in meters']) {
		const r = parseBForValue(v);
		assertEquals('error' in r && r.error.startsWith('b-for value must be in the form'), true, v);
	}
});

Deno.test("parseBForValue: invalid names are reported", () => {
	for (const v of [' in items', '1x in items', 'a.b in items', 'm, in items', ', i in items', 'a b in items', '$x in items', '() in items']) {
		const r = parseBForValue(v);
		assertEquals('error' in r && r.error.includes('is not a valid loop variable name'), true, v);
	}
});

Deno.test("parseBForValue: `_` as the value binds only the index", () => {
	assertEquals(bfor('_, i in widgets'), { valName: undefined, indexName: 'i', vars: ['widgets'] });
	assertEquals(bfor('(_, i) in widgets'), { valName: undefined, indexName: 'i', vars: ['widgets'] });
});

Deno.test("parseBForValue: `_` as the index binds only the value", () => {
	assertEquals(bfor('w, _ in widgets'), { valName: 'w', indexName: undefined, vars: ['widgets'] });
});

Deno.test("parseBForValue: `_` alone or twice binds nothing", () => {
	assertEquals(bfor('_ in widgets'), { valName: undefined, indexName: undefined, vars: ['widgets'] });
	assertEquals(bfor('_, _ in widgets'), { valName: undefined, indexName: undefined, vars: ['widgets'] });
});

Deno.test("parseBForValue: an omitted value is an invalid name, not a skip", () => {
	const r = parseBForValue(', i in widgets');
	assertEquals('error' in r && r.error.includes('is not a valid loop variable name'), true);
});

Deno.test("parseBForValue: value and index with the same name is an error", () => {
	const r = parseBForValue('x, x in xs');
	assertEquals('error' in r && r.error.includes('"x"'), true);
	assertEquals('error' in r && r.error.includes('same name'), true);
});

// ---- text lowering ({{ }} splitting) unit tests ----
// These drive lowerSlice with a hand-built source tree whose text nodes lower
// directly into a b-unwrap partial root, i.e. straight into root.tnodes with no
// wrapping element — the shortest path to the {{ }} splitter's output.

function lowerTextRuns(...raws: string[]): TNode[] {
	const children: SourceText[] = raws.map(raw => ({ kind: 'text', raw }));
	const nodes: SourceNode[] = [{
		kind: 'element',
		tagName: 'b-unwrap',
		attrs: [{ name: 'b-name', value: 't' }],
		selfClosing: false,
		isVoid: false,
		rawOpenTag: '<b-unwrap b-name="t">',
		rawCloseTag: '</b-unwrap>',
		children,
	}];
	const def: PartialDef = { name: 't', exported: false, customElement: false, loc: { filename: 'test.html', from: 1, to: 1 } };
	const { compiledFile } = lowerSlice(nodes, def, undefined);
	return compiledFile.partials.get('t')!.tnodes;
}

Deno.test("lowerText: plain text becomes a raw node", () => {
	assertEquals(lowerTextRuns('world'), [{ type: 'raw', raw: 'world' }]);
});

Deno.test("lowerText: adjacent text runs coalesce into one raw node", () => {
	assertEquals(lowerTextRuns('hello', 'world'), [{ type: 'raw', raw: 'helloworld' }]);
});

Deno.test("lowerText: single interpolation (no seed raw)", () => {
	assertEquals(lowerTextRuns('{{ g }}'), [
		{ type: 'print', data: interpretBackcode('g') },
	]);
});

Deno.test("lowerText: text before interpolation", () => {
	assertEquals(lowerTextRuns('hello {{ g }}'), [
		{ type: 'raw', raw: 'hello ' },
		{ type: 'print', data: interpretBackcode('g') },
	]);
});

Deno.test("lowerText: text around interpolation", () => {
	assertEquals(lowerTextRuns('hello {{ g }} world'), [
		{ type: 'raw', raw: 'hello ' },
		{ type: 'print', data: interpretBackcode('g') },
		{ type: 'raw', raw: ' world' },
	]);
});

Deno.test("lowerText: two interpolations with surrounding text", () => {
	assertEquals(lowerTextRuns('hello {{ g }}{{ k }} world'), [
		{ type: 'raw', raw: 'hello ' },
		{ type: 'print', data: interpretBackcode('g') },
		{ type: 'print', data: interpretBackcode('k') },
		{ type: 'raw', raw: ' world' },
	]);
});

Deno.test("lowerText: parentheses in expression still produce a print node", () => {
	const tnodes = lowerTextRuns('{{ func() }}');
	assertEquals(tnodes.length, 1);
	assertEquals(tnodes[0].type, 'print');
});

Deno.test("lowerText: empty braces skipped, treated as raw text", () => {
	const tnodes = lowerTextRuns('before{{  }}after');
	assertEquals(tnodes.length, 1);
	assertEquals((tnodes[0] as RawTNode).raw, 'before{{  }}after');
});

// ---- collectSlots unit tests ----

Deno.test("collectSlots: finds slots in nested containers", () => {
	const tree: TNode[] = [
		{ type: 'slot', name: 'a' },
		{ type: 'element', tagName: 'div', attrs: [], tnodes: [{ type: 'slot', name: undefined }] },
		{ type: 'if', branches: [{ tnodes: [{ type: 'slot', name: 'b' }] }] },
	];
	assertEquals(collectSlots(tree).sort(), ['a', 'b', 'default']);
});

Deno.test("collectSlots: finds a b-slot written inside a call body (slot forwarding)", () => {
	// A b-slot nested in a partial-ref's slot content is lexically part of *this*
	// partial and resolves against this partial's slot map, so it counts here.
	const tree: TNode[] = [
		{ type: 'partial-ref', kind: 'b-part', file: null, partialName: 'child', bindings: [],
			slots: { default: [], target: [{ type: 'slot', name: 'forwarded' }] } },
	];
	assertEquals(collectSlots(tree), ['forwarded']);
});
