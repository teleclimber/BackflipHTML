import { assertEquals } from "jsr:@std/assert";

import type { ElementTNode, AttrPart, PrintTNode, IfTNode, IfBranch } from "../../types.ts";
import { interpretBackcode } from "../../backcode.ts";
import type { BackcodeSite, IfSetSite } from "./collect.ts";
import {
	generateClassForPartial,
	generateFile,
	runtimeImportsFor,
	classNameFor,
	type BfidSite,
	type IfSetPatchSite,
	type PatchBranch,
	type PatchTarget,
} from "./codegen.ts";
import { evalModule as evalModuleFor, plain } from "./test-helpers.ts";

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

function branch(sites: BfidSite[] = [], sets: IfSetPatchSite[] = []): PatchBranch {
	return { sites, sets, vars: computeVars(sites, sets) };
}

function dynAttr(name: string, code: string, isBoolean = false): AttrPart {
	return { type: 'dynamic', name, expr: interpretBackcode(code), isBoolean };
}

function attrBfidSite(bfid: string, attr: AttrPart, liveVars: string[]): BfidSite {
	if (attr.type !== 'dynamic') throw new Error('expected dynamic');
	const element: ElementTNode = { type: 'element', tagName: 'div', attrs: [attr], tnodes: [] };
	const backcode: BackcodeSite = {
		site: { kind: 'attr', element, attr },
		parsed: attr.expr, liveVars, inForLoop: false,
	};
	return { target: { kind: 'bfid-element', bfid }, backcode };
}

function printBfidSite(
	target: PatchTarget, code: string, liveVars: string[], startId: string, endId: string,
): BfidSite {
	const node: PrintTNode = { type: 'print', data: interpretBackcode(code) };
	const backcode: BackcodeSite = {
		site: { kind: 'print', node, container: [node], parentElement: null },
		parsed: interpretBackcode(code), liveVars, inForLoop: false,
	};
	return { target, backcode, comments: { startId, endId } };
}

function defRootBfidSite(attr: AttrPart, liveVars: string[]): BfidSite {
	if (attr.type !== 'dynamic') throw new Error('expected dynamic');
	const backcode: BackcodeSite = {
		site: { kind: 'definition-root-attr', attr },
		parsed: attr.expr, liveVars, inForLoop: false,
	};
	return { target: { kind: 'ref-element' }, backcode };
}

function callerAttrBfidSite(bfid: string, attr: AttrPart, liveVars: string[]): BfidSite {
	if (attr.type !== 'dynamic') throw new Error('expected dynamic');
	// `ref` is only stamped in nodes2patch; codegen never reads it, so a null cast is fine here.
	const backcode: BackcodeSite = {
		site: { kind: 'caller-attr-expr', ref: null as never, attr },
		parsed: attr.expr, liveVars, inForLoop: false,
	};
	return { target: { kind: 'bfid-element', bfid }, backcode };
}

// `conditions` are the branch expressions (null = b-else); `subtreeVars` and
// `branches` become the set descriptor's.
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
		liveVars: opts.liveVars, inForLoop: false,
	};
	return {
		target: opts.target, ifSet, setId: opts.setId, endId: opts.endId,
		snapshot: opts.snapshot ?? `{ type:'if', branches: [] }`,
		subtreeVars: opts.subtreeVars ?? [],
		branches: opts.branches ?? opts.conditions.map(() => null),
	};
}

const evalModule = (js: string, partialName = 'my-element') => evalModuleFor(js, partialName);

const NAME_ATTR = [{ name: 'name', isBool: false }];

// --- basics ----------------------------------------------------------------

Deno.test("classNameFor capitalizes parts", () => {
	assertEquals(classNameFor('my-element'), 'BackflipMyElement');
	assertEquals(classNameFor('foo-bar-baz'), 'BackflipFooBarBaz');
});

Deno.test("single attr site: exact module body", () => {
	const site = attrBfidSite('bf0', dynAttr('title', 'foo'), ['foo']);
	const js = generateClassForPartial('my-element', [{ name: 'foo', isBool: false }], branch([site]), 'render');
	assertEquals(js, `export class BackflipMyElement extends BackflipShell {
\tstatic bfAttrs = { foo: 'string' };
\tstatic bfRoot = {
\t\tsites: [
\t\t\t{ bfid: 'bf0', attr: 'title', expr: { fn: function ( foo ) { return foo; }, vars: ['foo'] } },
\t\t],
\t\tsets: [],
\t};
}`);
});

Deno.test("no qualifying sites or sets: returns null in render mode", () => {
	assertEquals(generateClassForPartial('my-element', [{ name: 'x', isBool: false }], branch(), 'render'), null);
});

// --- the shell ---------------------------------------------------------------

Deno.test("shell: bfAttrs types every b-attr, used or not; the shell extends BackflipShell", () => {
	const site = attrBfidSite('bf0', dynAttr('title', 'used'), ['used']);
	const js = generateClassForPartial('my-element',
		[{ name: 'used', isBool: false }, { name: 'unused', isBool: false }, { name: 'flag', isBool: true }], branch([site]), 'render')!;
	const { shell, bfAttrs, BackflipShell } = evalModule(js);
	assertEquals(bfAttrs, { used: 'string', unused: 'string', flag: 'bool' });
	assertEquals(Object.getPrototypeOf(shell), BackflipShell);
});

Deno.test("shell: the only class exported is the shell (render mode)", () => {
	const site = attrBfidSite('bf0', dynAttr('title', 'foo'), ['foo']);
	const js = generateClassForPartial('my-element', [{ name: 'foo', isBool: false }], branch([site]), 'render')!;
	assertEquals([...js.matchAll(/^export class (\w+)/gm)].map(m => m[1]), ['BackflipMyElement']);
	assertEquals(js.match(/^class /gm), null);
});

// --- site descriptors ----------------------------------------------------------

Deno.test("sites: an attr site names its element, attribute and expression", () => {
	const site = attrBfidSite('bf0', dynAttr('title', 'a + "-" + b'), ['a', 'b']);
	const js = generateClassForPartial('my-element', [{ name: 'a', isBool: false }, { name: 'b', isBool: false }], branch([site]), 'render')!;
	assertEquals(plain(evalModule(js).bfRoot, { a: 1, b: 2 }), {
		sites: [{ bfid: 'bf0', attr: 'title', expr: { vars: ['a', 'b'], value: '1-2' } }],
		sets: [],
	});
});

Deno.test("sites: a bool attr is marked bool", () => {
	const site = attrBfidSite('bf0', dynAttr('hidden', 'flag', true), ['flag']);
	const js = generateClassForPartial('my-element', [{ name: 'flag', isBool: true }], branch([site]), 'render')!;
	assertEquals(plain(evalModule(js).bfRoot.sites[0], { flag: true }),
		{ bfid: 'bf0', attr: 'hidden', bool: true, expr: { vars: ['flag'], value: true } });
});

Deno.test("sites: a caller attr is an attr site on the call's element", () => {
	const site = callerAttrBfidSite('bf0', dynAttr('show', 'show'), ['show']);
	const js = generateClassForPartial('parent-el', [{ name: 'show', isBool: false }], branch([site]), 'render')!;
	assertEquals(plain(evalModule(js, 'parent-el').bfRoot.sites[0], { show: 'x' }),
		{ bfid: 'bf0', attr: 'show', expr: { vars: ['show'], value: 'x' } });
});

Deno.test("sites: a definition-root attr targets the ref element (bfid null)", () => {
	const site = defRootBfidSite(dynAttr('class', 'flag'), ['flag']);
	const js = generateClassForPartial('my-element', [{ name: 'flag', isBool: false }], branch([site]), 'render')!;
	assertEquals(plain(evalModule(js).bfRoot.sites[0], { flag: 'on' }),
		{ bfid: null, attr: 'class', expr: { vars: ['flag'], value: 'on' } });
});

Deno.test("sites: an attribute name is kept as written", () => {
	const site = attrBfidSite('bf0', dynAttr('data-foo', 'foo'), ['foo']);
	const js = generateClassForPartial('my-element', [{ name: 'foo', isBool: false }], branch([site]), 'render')!;
	assertEquals(evalModule(js).bfRoot.sites[0].attr, 'data-foo');
});

Deno.test("sites: a print names its parent element and its marker comments", () => {
	const onElem = printBfidSite({ kind: 'bfid-element', bfid: 'bf0' }, 'name', ['name'], 'bf1', 'bf2');
	const onRef = printBfidSite({ kind: 'ref-element' }, 'name', ['name'], 'bf3', 'bf4');
	const js = generateClassForPartial('my-element', NAME_ATTR, branch([onElem, onRef]), 'render')!;
	assertEquals(plain(evalModule(js).bfRoot.sites, { name: 'N' }), [
		{ bfid: 'bf0', markers: ['bfid:bf1', 'bfid:bf2'], expr: { vars: ['name'], value: 'N' } },
		{ bfid: null, markers: ['bfid:bf3', 'bfid:bf4'], expr: { vars: ['name'], value: 'N' } },
	]);
});

Deno.test("sites: an unsupported site kind throws (must be filtered before codegen)", () => {
	const bindingSite: BfidSite = {
		target: { kind: 'bfid-element', bfid: 'bf0' },
		backcode: {
			site: { kind: 'binding', ref: {} as any, binding: { kind: 'expr', name: 'x', data: interpretBackcode('x') } },
			parsed: interpretBackcode('x'), liveVars: ['x'], inForLoop: false,
		},
	};
	let threw = false;
	try {
		generateClassForPartial('my-element', [{ name: 'x', isBool: false }], branch([bindingSite]), 'render');
	} catch (e) {
		threw = true;
		assertEquals(String(e).includes("unsupported site kind 'binding'"), true);
	}
	assertEquals(threw, true);
});

// --- set descriptors -----------------------------------------------------------

Deno.test("sets: a set names its anchor, markers, snapshot const and subtree vars", () => {
	const set = ifPatchSite({
		target: { kind: 'bfid-element', bfid: 'bf9' }, conditions: ['mode == 1', null], liveVars: ['mode'],
		setId: 'bf0', endId: 'bf1', subtreeVars: ['name'], snapshot: `{ type:'if', branches: [] }`,
	});
	const js = generateClassForPartial('my-element', [{ name: 'mode', isBool: false }, { name: 'name', isBool: false }], branch([], [set]), 'render')!;
	// The snapshot is a module-level const, before the shell.
	assertEquals(js.startsWith("const bfif_bf0 = { type:'if', branches: [] };"), true);
	const { bfRoot, defined } = evalModule(js);
	const d = bfRoot.sets[0];
	assertEquals(d.snapshot, defined.bfif_bf0);
	assertEquals({ ...d, snapshot: undefined }, {
		bfid: 'bf9', markers: ['bfid:bf0', 'bfid:bf1'], snapshot: undefined, subtreeVars: ['name'], branches: [null, null],
	});
});

Deno.test("sets: a set on the ref element has bfid null", () => {
	const set = ifPatchSite({ target: { kind: 'ref-element' }, conditions: ['flag'], liveVars: ['flag'], setId: 'bf0', endId: 'bf1' });
	const js = generateClassForPartial('my-element', [{ name: 'flag', isBool: true }], branch([], [set]), 'render')!;
	assertEquals(evalModule(js).bfRoot.sets[0].bfid, null);
});

Deno.test("sets: a branch with patchable content gets a nested descriptor; others null", () => {
	const child = branch([attrBfidSite('bf5', dynAttr('title', 'name'), ['name'])]);
	const set = ifPatchSite({
		target: { kind: 'ref-element' }, conditions: ['a', 'b', null], liveVars: ['a', 'b'], setId: 'bf0', endId: 'bf1',
		subtreeVars: ['name'], branches: [null, child, null],
	});
	const js = generateClassForPartial('my-element',
		[{ name: 'a', isBool: false }, { name: 'b', isBool: false }, { name: 'name', isBool: false }], branch([], [set]), 'render')!;
	assertEquals(plain(evalModule(js).bfRoot.sets[0].branches, { name: 'N' }), [
		null,
		{ sites: [{ bfid: 'bf5', attr: 'title', expr: { vars: ['name'], value: 'N' } }], sets: [] },
		null,
	]);
});

Deno.test("sets: nested sets nest their descriptors; snapshot consts come innermost-first", () => {
	const inner = ifPatchSite({
		target: { kind: 'bfid-element', bfid: 'bf5' }, conditions: ['b'], liveVars: ['b'], setId: 'bf2', endId: 'bf3',
		snapshot: `{ type:'if', branches: [], inner: true }`,
	});
	const outer = ifPatchSite({
		target: { kind: 'ref-element' }, conditions: ['a'], liveVars: ['a'], setId: 'bf0', endId: 'bf1',
		subtreeVars: ['b'], branches: [branch([], [inner])], snapshot: `{ type:'if', branches: [], outer: true }`,
	});
	const js = generateClassForPartial('my-element', [{ name: 'a', isBool: false }, { name: 'b', isBool: false }], branch([], [outer]), 'render')!;
	assertEquals(js.indexOf('const bfif_bf2 ') < js.indexOf('const bfif_bf0 '), true);
	const { bfRoot, defined } = evalModule(js);
	const nested = bfRoot.sets[0].branches[0].sets[0];
	assertEquals(nested.snapshot, defined.bfif_bf2);
	assertEquals(nested.markers, ['bfid:bf2', 'bfid:bf3']);
	assertEquals(nested.bfid, 'bf5');
});

// --- the module ---------------------------------------------------------------

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

Deno.test("generateFile imports each runtime file by its path from the output root, before the classes", () => {
	assertEquals(generateFile(['class A {}']).includes('import'), false);
	const out = generateFile(['class A {}'], new Map([['runtime/dom-patch/patch.js', ['BackflipShell', 'BackflipElement']]]));
	assertEquals(out.includes("import { BackflipShell, BackflipElement } from './runtime/dom-patch/patch.js';"), true);
	assertEquals(out.lastIndexOf('import') < out.indexOf('class A'), true);
});

Deno.test("runtimeImportsFor: every mode imports BackflipShell; base and full add BackflipElement", () => {
	assertEquals([...runtimeImportsFor('render')], [['runtime/dom-patch/patch.js', ['BackflipShell']]]);
	for (const mode of ['base', 'full'] as const) {
		assertEquals([...runtimeImportsFor(mode)], [['runtime/dom-patch/patch.js', ['BackflipShell', 'BackflipElement']]]);
	}
});

// --- b-generate modes ------------------------------------------------------

const bAttrs = [{ name: 'title', isBool: false }, { name: 'flag', isBool: true }];

function forMode(mode: 'render' | 'base' | 'full'): string {
	const site = attrBfidSite('bf0', dynAttr('data-x', 'title'), ['title']);
	return generateClassForPartial('my-widget', bAttrs, branch([site]), mode)!;
}

Deno.test("modes: render emits the shell only — no element class, no define", () => {
	const js = forMode('render');
	assertEquals(js.includes('export class BackflipMyWidget extends BackflipShell {'), true);
	assertEquals(js.includes('BackflipElement'), false);
	assertEquals(js.includes('customElements.define'), false);
});

Deno.test("modes: base adds the element class but does not define it", () => {
	const js = forMode('base');
	assertEquals(js.includes('export class BackflipMyWidgetElement extends BackflipElement {'), true);
	assertEquals(js.includes('customElements.define'), false);
});

Deno.test("modes: full adds the define, guarded against a duplicate registration", () => {
	const js = forMode('full');
	assertEquals(js.includes('export class BackflipMyWidgetElement extends BackflipElement {'), true);
	assertEquals(
		js.includes("if (!customElements.get('my-widget')) customElements.define('my-widget', BackflipMyWidgetElement);"),
		true,
	);
});

Deno.test("modes: the element class only names its shell", () => {
	const js = forMode('base');
	assertEquals(js.slice(js.indexOf('export class BackflipMyWidgetElement')), [
		'export class BackflipMyWidgetElement extends BackflipElement {',
		'\tstatic bfShell = BackflipMyWidget;',
		'}',
	].join('\n'));
	const { defined } = evalModule(js, 'my-widget');
	assertEquals(defined.BackflipMyWidgetElement.bfShell, defined.BackflipMyWidget);
});

Deno.test("modes: base and full still emit when there is nothing to patch", () => {
	const empty = branch();
	for (const mode of ['base', 'full'] as const) {
		const js = generateClassForPartial('my-widget', [], empty, mode)!;
		assertEquals(js.includes('export class BackflipMyWidgetElement extends BackflipElement {'), true);
		// No attrs and no root: the shell keeps the base class's empty defaults.
		const { bfAttrs, bfRoot } = evalModule(js, 'my-widget');
		assertEquals(bfAttrs, undefined);
		assertEquals(bfRoot, undefined);
	}
	// Declared attrs with nothing to patch are still observed.
	const { bfAttrs, bfRoot } = evalModule(generateClassForPartial('my-widget', bAttrs, empty, 'base')!, 'my-widget');
	assertEquals(bfAttrs, { title: 'string', flag: 'bool' });
	assertEquals(bfRoot, undefined);
});
