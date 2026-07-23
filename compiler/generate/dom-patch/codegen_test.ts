import { assertEquals } from "jsr:@std/assert";

import type { ElementTNode, AttrPart, PrintTNode, IfTNode, IfBranch } from "../../types.ts";
import { interpretBackcode } from "../../backcode.ts";
import type { BackcodeSite, IfSetSite } from "./collect.ts";
import {
	generateClassForPartial,
	generateFile,
	classNameFor,
	patchClassNameFor,
	sanitizeAttrName,
	type BfidSite,
	type IfSetPatchSite,
	type PatchBranch,
	type PatchTarget,
} from "./codegen.ts";

// --- helpers ---------------------------------------------------------------

function computeVars(sites: BfidSite[], sets: IfSetPatchSite[]): string[] {
	const out: string[] = [];
	const note = (v: string) => { if (!out.includes(v)) out.push(v); };
	for (const s of sites) for (const v of s.backcode.liveVars) note(v);
	for (const s of sets) {
		for (const v of s.ifSet.liveVars) note(v);
		for (const v of s.subtreeVars) note(v);
	}
	return out;
}

function branch(sites: BfidSite[] = [], sets: IfSetPatchSite[] = [], className = 'BackflipPatch_MyElement'): PatchBranch {
	return { className, sites, sets, vars: computeVars(sites, sets) };
}

function dynAttr(name: string, code: string, isBoolean = false): AttrPart {
	return { type: 'dynamic', name, expr: interpretBackcode(code), isBoolean };
}

function attrBfidSite(bfid: string, attr: AttrPart, liveVars: string[]): BfidSite {
	if (attr.type !== 'dynamic') throw new Error('expected dynamic');
	const element: ElementTNode = { type: 'element', tagName: 'div', attrs: [attr], tnodes: [] };
	const backcode: BackcodeSite = {
		site: { kind: 'attr', element, attr },
		parsed: attr.expr, liveVars, otherVars: [], inForLoop: false,
	};
	return { target: { kind: 'bfid-element', bfid }, backcode };
}

function printBfidSite(
	target: PatchTarget, code: string, liveVars: string[], startId: string, endId: string,
): BfidSite {
	const node: PrintTNode = { type: 'print', data: interpretBackcode(code) };
	const backcode: BackcodeSite = {
		site: { kind: 'print', node, container: [node], parentElement: null },
		parsed: interpretBackcode(code), liveVars, otherVars: [], inForLoop: false,
	};
	return { target, backcode, comments: { startId, endId } };
}

function defRootBfidSite(attr: AttrPart, liveVars: string[]): BfidSite {
	if (attr.type !== 'dynamic') throw new Error('expected dynamic');
	const backcode: BackcodeSite = {
		site: { kind: 'definition-root-attr', attr },
		parsed: attr.expr, liveVars, otherVars: [], inForLoop: false,
	};
	return { target: { kind: 'ref-element' }, backcode };
}

// `conditions` are the branch expressions (null = b-else); `subtreeVars` and
// `branches` drive the forwarding/child-class logic.
function ifPatchSite(opts: {
	target: PatchTarget;
	conditions: (string | null)[];
	liveVars: string[];
	setId: string;
	endId: string;
	subtreeVars?: string[];
	branches?: (PatchBranch | null)[];
	snapshot?: string;
}): IfSetPatchSite {
	const brs: IfBranch[] = opts.conditions.map(c =>
		c === null ? { tnodes: [] } : { condition: interpretBackcode(c), tnodes: [] });
	const node: IfTNode = { type: 'if', branches: brs };
	const ifSet: IfSetSite = {
		kind: 'if-set', node, container: [node], parentElement: null,
		liveVars: opts.liveVars, otherVars: [], inForLoop: false,
	};
	return {
		target: opts.target, ifSet, setId: opts.setId, endId: opts.endId,
		snapshot: opts.snapshot ?? `{ type:'if', branches: [] }`,
		subtreeVars: opts.subtreeVars ?? [],
		branches: opts.branches ?? opts.conditions.map(() => null),
	};
}

// --- basics ----------------------------------------------------------------

Deno.test("classNameFor capitalizes parts", () => {
	assertEquals(classNameFor('my-element'), 'BackflipMyElement');
	assertEquals(classNameFor('foo-bar-baz'), 'BackflipFooBarBaz');
	assertEquals(classNameFor('x'), 'BackflipX');
});

Deno.test("patchClassNameFor mirrors classNameFor with the Patch_ infix", () => {
	assertEquals(patchClassNameFor('my-element'), 'BackflipPatch_MyElement');
	assertEquals(patchClassNameFor('foo-bar'), 'BackflipPatch_FooBar');
});

Deno.test("sanitizeAttrName replaces non-id chars with underscore", () => {
	assertEquals(sanitizeAttrName('title'), 'title');
	assertEquals(sanitizeAttrName('data-foo'), 'data_foo');
	assertEquals(sanitizeAttrName('aria-label'), 'aria_label');
});

Deno.test("single attr, single live var: exact-string patch-branch + shell", () => {
	const site = attrBfidSite('bf0', dynAttr('title', 'foo'), ['foo']);
	const js = generateClassForPartial('my-element', [{ name: 'foo', isBool: false }], branch([site]));
	const expected = `class BackflipPatch_MyElement {
\tconstructor(ref_elem, data) {
\t\tthis.ref_elem = ref_elem;
\t}

\tsel_bf0() { return this.ref_elem.querySelector('[data-bfid="bf0"]'); }

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
\t\t\tconsole.error('BackflipHTML BackflipPatch_MyElement: element [data-bfid="bf0"] not found; skipping update', this.ref_elem);
\t\t}
\t}

\tupdate(varname, data) {
\t\tswitch (varname) {
\t\t\tcase 'foo': this.mutate_foo(data); break;
\t\t}
\t}
}

export class BackflipMyElement {
\tconstructor(ce) {
\t\tthis.ce = ce;
\t\tthis.pb = new BackflipPatch_MyElement(this.ce, this.collectData());
\t}
\tcollectData() {
\t\treturn {
\t\t\tfoo: this.ce.getAttribute('foo') ?? '',
\t\t};
\t}
\tupdate(varname) {
\t\tthis.pb.update(varname, this.collectData());
\t}
}`;
	assertEquals(js, expected);
});

Deno.test("patch-branch classes are not exported; only the shell is", () => {
	const site = attrBfidSite('bf0', dynAttr('title', 'foo'), ['foo']);
	const js = generateClassForPartial('my-element', [{ name: 'foo', isBool: false }], branch([site]))!;
	assertEquals(js.includes('class BackflipPatch_MyElement {'), true);
	assertEquals(js.includes('export class BackflipPatch_MyElement'), false);
	assertEquals(js.includes('export class BackflipMyElement {'), true);
});

Deno.test("null bfid element: mutate logs console.error against ref_elem", () => {
	const site = attrBfidSite('bf0', dynAttr('title', 'foo'), ['foo']);
	const js = generateClassForPartial('my-element', [{ name: 'foo', isBool: false }], branch([site]))!;
	assertEquals(
		js.includes(`} else {\n\t\t\tconsole.error('BackflipHTML BackflipPatch_MyElement: element [data-bfid="bf0"] not found; skipping update', this.ref_elem);\n\t\t}`),
		true,
	);
});

Deno.test("ref-element site: no sel, targets this.ref_elem, ref-element error", () => {
	const site = defRootBfidSite(dynAttr('class', 'flag'), ['flag']);
	const js = generateClassForPartial('my-element', [{ name: 'flag', isBool: false }], branch([site]))!;
	assertEquals(js.includes('sel_'), false);
	assertEquals(js.includes('querySelector'), false);
	assertEquals(js.includes('elem = this.ref_elem;'), true);
	assertEquals(js.includes("elem.setAttribute('class', String(this.bc_ce_class(data)))"), true);
	assertEquals(
		js.includes(`console.error('BackflipHTML BackflipPatch_MyElement: ref element not found; skipping update', this.ref_elem);`),
		true,
	);
});

Deno.test("two attrs on same element with same live var: one sel, two bc, one lookup", () => {
	const site1 = attrBfidSite('bf0', dynAttr('title', 'foo'), ['foo']);
	const site2 = attrBfidSite('bf0', dynAttr('aria-label', 'foo'), ['foo']);
	const js = generateClassForPartial('my-element', [{ name: 'foo', isBool: false }], branch([site1, site2]))!;
	assertEquals(js.match(/sel_bf0\(\)/g)?.length, 2); // declaration + one call inside mutate_foo
	assertEquals(js.includes('bc_bf0_title(data)'), true);
	assertEquals(js.includes('bc_bf0_aria_label(data)'), true);
	assertEquals(js.match(/elem = this\.sel_bf0\(\);/g)?.length, 1);
});

Deno.test("bool dynamic attr uses setAttribute/removeAttribute pattern", () => {
	const site = attrBfidSite('bf0', dynAttr('hidden', 'flag', true), ['flag']);
	const js = generateClassForPartial('my-element', [{ name: 'flag', isBool: true }], branch([site]))!;
	assertEquals(js.includes("flag: this.ce.hasAttribute('flag')"), true);
	assertEquals(
		js.includes(`if (this.bc_bf0_hidden(data)) elem.setAttribute('hidden', ''); else elem.removeAttribute('hidden');`),
		true,
	);
});

Deno.test("b-attr present but never used: in collectData, NOT in update", () => {
	const site = attrBfidSite('bf0', dynAttr('title', 'used'), ['used']);
	const js = generateClassForPartial('my-element',
		[{ name: 'used', isBool: false }, { name: 'unused', isBool: false }], branch([site]))!;
	assertEquals(js.includes("unused: this.ce.getAttribute('unused') ?? ''"), true);
	assertEquals(js.includes("mutate_unused"), false);
	assertEquals(js.includes("case 'unused'"), false);
});

Deno.test("no qualifying sites or sets: returns null", () => {
	assertEquals(generateClassForPartial('my-element', [{ name: 'x', isBool: false }], branch([], [])), null);
});

Deno.test("attr name data-foo sanitizes in fn but keeps data-foo in DOM call", () => {
	const site = attrBfidSite('bf0', dynAttr('data-foo', 'foo'), ['foo']);
	const js = generateClassForPartial('my-element', [{ name: 'foo', isBool: false }], branch([site]))!;
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

Deno.test("generateFile emits the render import only when asked, with the given path", () => {
	assertEquals(generateFile(['class A {}']).includes('import'), false);
	const nested = generateFile(['class A {}'], '../../render.js');
	assertEquals(nested.includes("import { render } from '../../render.js';"), true);
	assertEquals(nested.indexOf('import') < nested.indexOf('class A'), true);
});

Deno.test("generated cluster is parseable JavaScript", () => {
	const site = attrBfidSite('bf0', dynAttr('title', 'foo + bar'), ['foo', 'bar']);
	const js = generateClassForPartial('my-element',
		[{ name: 'foo', isBool: false }, { name: 'bar', isBool: false }], branch([site]))!;
	const Cls = new Function(js.replaceAll('export class', 'class') + '; return BackflipMyElement;')();
	assertEquals(typeof Cls, 'function');
});

Deno.test("unsupported site kind throws (must be filtered before reaching codegen)", () => {
	const bindingSite: BfidSite = {
		target: { kind: 'bfid-element', bfid: 'bf0' },
		backcode: {
			site: { kind: 'binding', ref: {} as any, binding: { kind: 'expr', name: 'x', data: interpretBackcode('x') } },
			parsed: interpretBackcode('x'), liveVars: ['x'], otherVars: [], inForLoop: false,
		},
	};
	let threw = false;
	try {
		generateClassForPartial('my-element', [{ name: 'x', isBool: false }], branch([bindingSite]));
	} catch (e) {
		threw = true;
		assertEquals(String(e).includes("unsupported site kind 'binding'"), true);
	}
	assertEquals(threw, true);
});

// --- print sites -----------------------------------------------------------

Deno.test("print site on a body element: sel + bc_print + replaceBetween + helper", () => {
	const site = printBfidSite({ kind: 'bfid-element', bfid: 'bf0' }, 'name', ['name'], 'bf1', 'bf2');
	const js = generateClassForPartial('my-widget', [{ name: 'name', isBool: false }], branch([site]))!;
	assertEquals(js.includes("sel_bf0() { return this.ref_elem.querySelector('[data-bfid=\"bf0\"]'); }"), true);
	assertEquals(js.includes('bc_print_bf1(data)'), true);
	assertEquals(js.includes("this.replaceBetween(elem, 'bfid:bf1', 'bfid:bf2', document.createTextNode(String(this.bc_print_bf1(data))));"), true);
	assertEquals(js.match(/replaceBetween\(parent, startMarker, endMarker, node\) \{/g)?.length, 1);
});

Deno.test("print site anchored to ref_elem: targets this.ref_elem, no sel", () => {
	const site = printBfidSite({ kind: 'ref-element' }, 'name', ['name'], 'bf0', 'bf1');
	const js = generateClassForPartial('my-widget', [{ name: 'name', isBool: false }], branch([site]))!;
	assertEquals(js.includes('querySelector'), false);
	assertEquals(js.includes('elem = this.ref_elem;'), true);
	assertEquals(js.includes("this.replaceBetween(elem, 'bfid:bf0', 'bfid:bf1', document.createTextNode(String(this.bc_print_bf0(data))));"), true);
});

Deno.test("no print sites and no if-sets: replaceBetween helper is not emitted", () => {
	const site = attrBfidSite('bf0', dynAttr('title', 'foo'), ['foo']);
	const js = generateClassForPartial('my-widget', [{ name: 'foo', isBool: false }], branch([site]))!;
	assertEquals(js.includes('replaceBetween'), false);
});

// --- if-sets ---------------------------------------------------------------

Deno.test("if-set: snapshot const, branch/renderIf/getCreate methods, constructor seeding", () => {
	const site = ifPatchSite({
		target: { kind: 'bfid-element', bfid: 'bf9' }, conditions: [`mode == 1`, null],
		liveVars: ['mode'], setId: 'bf0', endId: 'bf1', snapshot: `{ type:'if', branches: [] }`,
	});
	const js = generateClassForPartial('my-widget', [{ name: 'mode', isBool: false }], branch([], [site]))!;
	// Module-level snapshot const precedes the classes.
	assertEquals(js.startsWith("const bfif_bf0 = { type:'if', branches: [] };"), true);
	assertEquals(js.includes('branch_bf0(data) {'), true);
	assertEquals(js.includes('const { mode } = data;'), true);
	assertEquals(js.includes('if ((mode == 1)) return 0;'), true);
	assertEquals(js.includes('return 1;'), true);
	assertEquals(js.includes('return -1;'), false);
	// getCreatePatchBranch present but with no case (both branches have no content here).
	assertEquals(js.includes('getCreatePatchBranch_bf0(branch_i, data) {'), true);
	// renderIf returns a bool and creates the branch it rendered.
	assertEquals(js.includes('renderIf_bf0(data) {'), true);
	assertEquals(js.includes('if (idx === this.if_bf0) return false;'), true);
	assertEquals(js.includes('const frag = range.createContextualFragment(render(bfif_bf0, data));'), true);
	assertEquals(js.includes("this.replaceBetween(elem, 'bfid:bf0', 'bfid:bf1', frag);"), true);
	assertEquals(js.includes('this.getCreatePatchBranch_bf0(idx, data);'), true);
	assertEquals(js.includes('return true;'), true);
	// Constructor seeds the index + map + eagerly creates the active child, no render.
	assertEquals(js.includes('this.if_bf0 = this.branch_bf0(data);'), true);
	assertEquals(js.includes('this.if_pb_bf0 = new Map();'), true);
	assertEquals(js.includes('this.getCreatePatchBranch_bf0(this.if_bf0, data);'), true);
	// The condition var drives update() and mutate forwards a plain renderIf.
	assertEquals(js.includes("case 'mode': this.mutate_mode(data); break;"), true);
	assertEquals(js.includes('this.renderIf_bf0(data);'), true);
});

Deno.test("if-set with no b-else falls through to -1", () => {
	const site = ifPatchSite({
		target: { kind: 'ref-element' }, conditions: ['flag'], liveVars: ['flag'], setId: 'bf0', endId: 'bf1',
	});
	const js = generateClassForPartial('my-widget', [{ name: 'flag', isBool: true }], branch([], [site]))!;
	assertEquals(js.includes('if (flag) return 0;'), true);
	assertEquals(js.includes('return -1;'), true);
	// ref-element target: no querySelector.
	assertEquals(js.includes('const elem = this.ref_elem;'), true);
	assertEquals(js.includes('querySelector'), false);
});

Deno.test("getCreatePatchBranch emits a case only for branches with a child class", () => {
	const child = branch(
		[attrBfidSite('bf5', dynAttr('title', 'name'), ['name'])], [], 'BackflipPatch_bf0_0');
	const site = ifPatchSite({
		target: { kind: 'ref-element' }, conditions: ['mode', null], liveVars: ['mode'],
		setId: 'bf0', endId: 'bf1', subtreeVars: ['name'],
		branches: [child, null],   // branch 0 has content, b-else is empty
	});
	const js = generateClassForPartial('my-widget',
		[{ name: 'mode', isBool: false }, { name: 'name', isBool: false }], branch([], [site]))!;
	// Exactly one case: branch 0. The child class receives this.ref_elem.
	assertEquals(js.includes('case 0: pb = new BackflipPatch_bf0_0(this.ref_elem, data); break;'), true);
	assertEquals(js.includes('case 1:'), false);
	// The child class is emitted (not exported).
	assertEquals(js.includes('class BackflipPatch_bf0_0 {'), true);
	assertEquals(js.includes('export class BackflipPatch_bf0_0'), false);
});

Deno.test("mutate for a var in both condition and subtree: re-render OR forward", () => {
	// `level` is both the set's condition var and referenced inside the branch.
	const site = ifPatchSite({
		target: { kind: 'ref-element' }, conditions: ['level', null], liveVars: ['level'],
		setId: 'bf0', endId: 'bf1', subtreeVars: ['level'],
		branches: [branch([], [], 'BackflipPatch_bf0_0'), null],
	});
	const js = generateClassForPartial('my-widget', [{ name: 'level', isBool: false }], branch([], [site]))!;
	const mut = js.slice(js.indexOf('mutate_level(data) {'), js.indexOf('update(varname'));
	assertEquals(mut.includes('if (!this.renderIf_bf0(data)) {'), true);
	assertEquals(mut.includes("if (pb) pb.update('level', data);"), true);
});

Deno.test("mutate for a subtree-only var forwards without re-rendering", () => {
	// `level` appears only inside the branch, never in the condition.
	const site = ifPatchSite({
		target: { kind: 'ref-element' }, conditions: ['mode', null], liveVars: ['mode'],
		setId: 'bf0', endId: 'bf1', subtreeVars: ['level'],
		branches: [branch([], [], 'BackflipPatch_bf0_0'), null],
	});
	const js = generateClassForPartial('my-widget',
		[{ name: 'mode', isBool: false }, { name: 'level', isBool: false }], branch([], [site]))!;
	const mut = js.slice(js.indexOf('mutate_level(data) {'), js.indexOf('\tupdate(varname'));
	assertEquals(mut.includes('renderIf'), false);        // no re-render for a subtree-only var
	assertEquals(mut.includes("if (pb) pb.update('level', data);"), true);
	// The subtree-only var still gets an update case.
	assertEquals(js.includes("case 'level': this.mutate_level(data); break;"), true);
});

Deno.test("if-set re-render is emitted before the element-group mutations", () => {
	// Both driven by `name`: the branch swap must run first, since the attr site
	// may live inside the branch that is about to be replaced.
	const attr = attrBfidSite('bf0', dynAttr('title', 'name'), ['name']);
	const ifSite = ifPatchSite({
		target: { kind: 'bfid-element', bfid: 'bf0' }, conditions: ['name'], liveVars: ['name'],
		setId: 'bf1', endId: 'bf2',
	});
	const js = generateClassForPartial('my-widget', [{ name: 'name', isBool: false }], branch([attr], [ifSite]))!;
	const body = js.slice(js.indexOf('mutate_name(data) {'));
	assertEquals(body.indexOf('this.renderIf_bf1(data);') < body.indexOf('elem = this.sel_bf0();'), true);
});

Deno.test("if-set alone emits the replaceBetween helper", () => {
	const site = ifPatchSite({
		target: { kind: 'ref-element' }, conditions: ['flag'], liveVars: ['flag'], setId: 'bf0', endId: 'bf1',
	});
	const js = generateClassForPartial('my-widget', [{ name: 'flag', isBool: true }], branch([], [site]))!;
	assertEquals(js.includes('replaceBetween(parent, startMarker, endMarker, node) {'), true);
});
