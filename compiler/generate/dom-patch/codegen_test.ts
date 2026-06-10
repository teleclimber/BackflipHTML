import { assertEquals } from "jsr:@std/assert";

import type { ElementTNode, AttrPart, PrintTNode } from "../../types.ts";
import { interpretBackcode } from "../../backcode.ts";
import type { BackcodeSite } from "./collect.ts";
import {
	generateClassForPartial,
	generateFile,
	classNameFor,
	sanitizeAttrName,
	type BfidSite,
	type PatchTarget,
} from "./codegen.ts";

function dynAttr(name: string, code: string, isBoolean = false): AttrPart {
	return { type: 'dynamic', name, expr: interpretBackcode(code), isBoolean };
}

function attrBfidSite(bfid: string, attr: AttrPart, liveVars: string[]): BfidSite {
	if (attr.type !== 'dynamic') throw new Error('expected dynamic');
	const element: ElementTNode = { type: 'element', tagName: 'div', attrs: [attr], tnodes: [] };
	const backcode: BackcodeSite = {
		site: { kind: 'attr', element, attr },
		parsed: attr.expr,
		liveVars,
		otherVars: [],
		inForLoop: false,
	};
	return { target: { kind: 'bfid-element', bfid }, backcode };
}

function printBfidSite(
	target: PatchTarget,
	code: string,
	liveVars: string[],
	startId: string,
	endId: string,
): BfidSite {
	const node: PrintTNode = { type: 'print', data: interpretBackcode(code) };
	const backcode: BackcodeSite = {
		site: { kind: 'print', node, container: [node], parentElement: null },
		parsed: interpretBackcode(code),
		liveVars,
		otherVars: [],
		inForLoop: false,
	};
	return { target, backcode, comments: { startId, endId } };
}

function defRootBfidSite(attr: AttrPart, liveVars: string[]): BfidSite {
	if (attr.type !== 'dynamic') throw new Error('expected dynamic');
	const backcode: BackcodeSite = {
		site: { kind: 'definition-root-attr', attr },
		parsed: attr.expr,
		liveVars,
		otherVars: [],
		inForLoop: false,
	};
	return { target: { kind: 'this-element' }, backcode };
}

Deno.test("classNameFor capitalizes parts", () => {
	assertEquals(classNameFor('my-element'), 'BackflipMyElement');
	assertEquals(classNameFor('foo-bar-baz'), 'BackflipFooBarBaz');
	assertEquals(classNameFor('x'), 'BackflipX');
});

Deno.test("sanitizeAttrName replaces non-id chars with underscore", () => {
	assertEquals(sanitizeAttrName('title'), 'title');
	assertEquals(sanitizeAttrName('data-foo'), 'data_foo');
	assertEquals(sanitizeAttrName('aria-label'), 'aria_label');
});

Deno.test("single attr, single live var: exact-string class", () => {
	const a = dynAttr('title', 'foo');
	const site = attrBfidSite('bf0', a, ['foo']);
	const js = generateClassForPartial('my-element', [{ name: 'foo', isBool: false }], [site]);
	const expected = `class BackflipMyElement {
\tconstructor(ce) { this.ce = ce; }

\tsel_bf0() { return this.ce.querySelector('[data-bfid="bf0"]'); }

\tbc_bf0_title(data) {
\t\tconst { foo } = data;
\t\treturn foo;
\t}

\tmutate_foo(data) {
\t\tlet elem;
\t\telem = this.sel_bf0();
\t\tif (elem) {
\t\t\telem.setAttribute('title', String(this.bc_bf0_title(data)));
\t\t} else {
\t\t\tconsole.error('BackflipHTML BackflipMyElement: element [data-bfid="bf0"] not found; skipping update', this.ce);
\t\t}
\t}

\tcollectData() {
\t\treturn {
\t\t\tfoo: this.ce.getAttribute('foo') ?? '',
\t\t};
\t}

\tupdate(varname) {
\t\tswitch (varname) {
\t\t\tcase 'foo': this.mutate_foo(this.collectData()); break;
\t\t}
\t}
}`;
	assertEquals(js, expected);
});

Deno.test("null bfid element: mutate logs console.error in else branch", () => {
	const a = dynAttr('title', 'foo');
	const site = attrBfidSite('bf0', a, ['foo']);
	const js = generateClassForPartial('my-element', [{ name: 'foo', isBool: false }], [site]);
	if (!js) throw new Error('expected js');
	assertEquals(
		js.includes(`} else {\n\t\t\tconsole.error('BackflipHTML BackflipMyElement: element [data-bfid="bf0"] not found; skipping update', this.ce);\n\t\t}`),
		true,
	);
});

Deno.test("null this element: mutate logs console.error in else branch", () => {
	const a = dynAttr('class', 'flag');
	const site = defRootBfidSite(a, ['flag']);
	const js = generateClassForPartial('my-element', [{ name: 'flag', isBool: false }], [site]);
	if (!js) throw new Error('expected js');
	assertEquals(
		js.includes(`} else {\n\t\t\tconsole.error('BackflipHTML BackflipMyElement: host element not found; skipping update');\n\t\t}`),
		true,
	);
});

Deno.test("two attrs on same element with same live var: one sel, two bc, both in one mutate", () => {
	const a1 = dynAttr('title', 'foo');
	const a2 = dynAttr('aria-label', 'foo');
	const site1 = attrBfidSite('bf0', a1, ['foo']);
	const site2 = attrBfidSite('bf0', a2, ['foo']);
	const js = generateClassForPartial('my-element', [{ name: 'foo', isBool: false }], [site1, site2]);
	if (!js) throw new Error('expected js');
	assertEquals(js.match(/sel_bf0\(\)/g)?.length, 2); // declaration + call inside mutate_foo
	assertEquals(js.includes('bc_bf0_title(data)'), true);
	assertEquals(js.includes('bc_bf0_aria_label(data)'), true);
	assertEquals(js.includes("setAttribute('aria-label'"), true);
	assertEquals(js.match(/mutate_foo\b/g)?.length, 2);
	assertEquals(js.match(/elem = this\.sel_bf0\(\);/g)?.length, 1);
});

Deno.test("two attrs on same element with two different live vars: shared sel across both mutates", () => {
	const a1 = dynAttr('title', 'foo');
	const a2 = dynAttr('class', 'bar');
	const site1 = attrBfidSite('bf0', a1, ['foo']);
	const site2 = attrBfidSite('bf0', a2, ['bar']);
	const js = generateClassForPartial('my-element',
		[{ name: 'foo', isBool: false }, { name: 'bar', isBool: false }],
		[site1, site2]);
	if (!js) throw new Error('expected js');
	assertEquals(js.includes('mutate_foo'), true);
	assertEquals(js.includes('mutate_bar'), true);
	assertEquals(js.match(/sel_bf0\(\) \{/g)?.length, 1);
});

Deno.test("bool b-attr uses hasAttribute in collectData", () => {
	const a = dynAttr('hidden', 'flag', true);
	const site = attrBfidSite('bf0', a, ['flag']);
	const js = generateClassForPartial('my-element', [{ name: 'flag', isBool: true }], [site]);
	if (!js) throw new Error('expected js');
	assertEquals(js.includes("flag: this.ce.hasAttribute('flag')"), true);
});

Deno.test("bool dynamic attr uses setAttribute/removeAttribute pattern", () => {
	const a = dynAttr('hidden', 'flag', true);
	const site = attrBfidSite('bf0', a, ['flag']);
	const js = generateClassForPartial('my-element', [{ name: 'flag', isBool: true }], [site]);
	if (!js) throw new Error('expected js');
	assertEquals(
		js.includes(`if (this.bc_bf0_hidden(data)) elem.setAttribute('hidden', ''); else elem.removeAttribute('hidden');`),
		true,
	);
});

Deno.test("b-attr present but never used: in collectData, NOT in update", () => {
	const a = dynAttr('title', 'used');
	const site = attrBfidSite('bf0', a, ['used']);
	const js = generateClassForPartial('my-element',
		[{ name: 'used', isBool: false }, { name: 'unused', isBool: false }],
		[site]);
	if (!js) throw new Error('expected js');
	assertEquals(js.includes("unused: this.ce.getAttribute('unused') ?? ''"), true);
	assertEquals(js.includes("mutate_unused"), false);
	assertEquals(js.includes("case 'unused'"), false);
});

Deno.test("no qualifying sites: returns null", () => {
	const js = generateClassForPartial('my-element', [{ name: 'x', isBool: false }], []);
	assertEquals(js, null);
});

Deno.test("attr name :title strips to title in DOM call, sanitized in fn name", () => {
	const a = dynAttr('title', 'foo');
	const site = attrBfidSite('bf0', a, ['foo']);
	const js = generateClassForPartial('my-element', [{ name: 'foo', isBool: false }], [site]);
	if (!js) throw new Error('expected js');
	assertEquals(js.includes("bc_bf0_title"), true);
	assertEquals(js.includes("setAttribute('title'"), true);
});

Deno.test("attr name data-foo sanitizes to data_foo in fn but keeps data-foo in DOM call", () => {
	const a = dynAttr('data-foo', 'foo');
	const site = attrBfidSite('bf0', a, ['foo']);
	const js = generateClassForPartial('my-element', [{ name: 'foo', isBool: false }], [site]);
	if (!js) throw new Error('expected js');
	assertEquals(js.includes("bc_bf0_data_foo"), true);
	assertEquals(js.includes("setAttribute('data-foo'"), true);
});

Deno.test("generateFile returns '' when no classes", () => {
	assertEquals(generateFile([null, null]), '');
});

Deno.test("generateFile concatenates classes with header", () => {
	const out = generateFile(['class A {}', 'class B {}']);
	assertEquals(out.startsWith('// Generated by BackflipHTML dom-patch'), true);
	assertEquals(out.includes('class A {}'), true);
	assertEquals(out.includes('class B {}'), true);
	assertEquals(out.endsWith('\n'), true);
});

Deno.test("generated class is parseable JavaScript", () => {
	const a = dynAttr('title', 'foo + bar');
	const site = attrBfidSite('bf0', a, ['foo', 'bar']);
	const js = generateClassForPartial('my-element',
		[{ name: 'foo', isBool: false }, { name: 'bar', isBool: false }],
		[site]);
	if (!js) throw new Error('expected js');
	const fn = new Function(js + '; return BackflipMyElement;');
	const Cls = fn();
	assertEquals(typeof Cls, 'function');
});

Deno.test("unsupported site kind throws (must be filtered before reaching codegen)", () => {
	const bindingSite: BfidSite = {
		target: { kind: 'bfid-element', bfid: 'bf0' },
		backcode: {
			// 'binding' is collected but not yet patchable — codegen must reject it.
			site: { kind: 'binding', ref: {} as any, binding: { kind: 'expr', name: 'x', data: interpretBackcode('x') } },
			parsed: interpretBackcode('x'),
			liveVars: ['x'], otherVars: [], inForLoop: false,
		},
	};
	let threw = false;
	try {
		generateClassForPartial('my-element', [{ name: 'x', isBool: false }], [bindingSite]);
	} catch (e) {
		threw = true;
		assertEquals(String(e).includes("unsupported site kind 'binding'"), true);
	}
	assertEquals(threw, true);
});

Deno.test("print site on a body element: sel + bc_print + patchTextBetween + helper", () => {
	const site = printBfidSite({ kind: 'bfid-element', bfid: 'bf0' }, 'name', ['name'], 'bf1', 'bf2');
	const js = generateClassForPartial('my-widget', [{ name: 'name', isBool: false }], [site]);
	if (!js) throw new Error('expected js');
	// Parent element is found via querySelector by its bfid.
	assertEquals(js.includes("sel_bf0() { return this.ce.querySelector('[data-bfid=\"bf0\"]'); }"), true);
	// The value function is keyed off the leading marker id.
	assertEquals(js.includes('bc_print_bf1(data)'), true);
	assertEquals(js.includes('const { name } = data;'), true);
	// The mutate call targets the parent and passes both marker strings + the stringified value.
	assertEquals(js.includes("this.patchTextBetween(elem, 'bfid:bf1', 'bfid:bf2', String(this.bc_print_bf1(data)));"), true);
	// The helper method is emitted exactly once.
	assertEquals(js.match(/patchTextBetween\(parent, startMarker, endMarker, text\) \{/g)?.length, 1);
	assertEquals(js.includes('document.createTextNode(text)'), true);
});

Deno.test("print site directly in the custom element: targets this.ce, no sel", () => {
	const site = printBfidSite({ kind: 'this-element' }, 'name', ['name'], 'bf0', 'bf1');
	const js = generateClassForPartial('my-widget', [{ name: 'name', isBool: false }], [site]);
	if (!js) throw new Error('expected js');
	assertEquals(js.includes('sel_'), false);
	assertEquals(js.includes('querySelector'), false);
	assertEquals(js.includes('elem = this.ce;'), true);
	assertEquals(js.includes("this.patchTextBetween(elem, 'bfid:bf0', 'bfid:bf1', String(this.bc_print_bf0(data)));"), true);
});

Deno.test("attr and print on same element + same var share one elem lookup", () => {
	const attr = attrBfidSite('bf0', dynAttr('title', 'name'), ['name']);
	const print = printBfidSite({ kind: 'bfid-element', bfid: 'bf0' }, 'name', ['name'], 'bf1', 'bf2');
	const js = generateClassForPartial('my-widget', [{ name: 'name', isBool: false }], [attr, print]);
	if (!js) throw new Error('expected js');
	// One mutate_name; one elem lookup shared by both the setAttribute and patchTextBetween.
	assertEquals(js.match(/elem = this\.sel_bf0\(\);/g)?.length, 1);
	assertEquals(js.includes("elem.setAttribute('title', String(this.bc_bf0_title(data)));"), true);
	assertEquals(js.includes("this.patchTextBetween(elem, 'bfid:bf1', 'bfid:bf2', String(this.bc_print_bf1(data)));"), true);
});

Deno.test("no print sites: patchTextBetween helper is not emitted", () => {
	const site = attrBfidSite('bf0', dynAttr('title', 'foo'), ['foo']);
	const js = generateClassForPartial('my-widget', [{ name: 'foo', isBool: false }], [site]);
	if (!js) throw new Error('expected js');
	assertEquals(js.includes('patchTextBetween'), false);
});
