import { assertEquals } from "jsr:@std/assert";

import type { RawTNode, TNode, PartialDef } from "./types.ts";
import type { SourceNode, SourceText } from "./parse-tree.ts";
import { isCustomElementTagName, parseBPartValue } from "./helpers.ts";
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

// ---- text lowering ({{ }} splitting) unit tests ----
// Ported from the old onText / pushRaw unit tests. The old tests seeded a
// container with an empty RawTNode and called onText against it; lowering text
// into a b-unwrap partial root does exactly that (the "seed" anchor), so these
// drive lowerSlice with a hand-built source tree containing one text node.

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
	const { compiledFile } = lowerSlice(nodes, def, undefined, raws.join(''));
	return compiledFile.partials.get('t')!.tnodes;
}

Deno.test("lowerText: plain text appended to the seeded raw node", () => {
	assertEquals(lowerTextRuns('world'), [{ type: 'raw', raw: 'world' }]);
});

Deno.test("lowerText: adjacent text runs coalesce into one raw node", () => {
	assertEquals(lowerTextRuns('hello', 'world'), [{ type: 'raw', raw: 'helloworld' }]);
});

Deno.test("lowerText: single interpolation (seed raw stays)", () => {
	assertEquals(lowerTextRuns('{{ g }}'), [
		{ type: 'raw', raw: '' },
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
	assertEquals(tnodes.length, 2);
	assertEquals(tnodes[1].type, 'print');
});

Deno.test("lowerText: empty braces skipped, treated as raw text", () => {
	const tnodes = lowerTextRuns('before{{  }}after');
	assertEquals(tnodes.length, 1);
	assertEquals((tnodes[0] as RawTNode).raw, 'before{{  }}after');
});
