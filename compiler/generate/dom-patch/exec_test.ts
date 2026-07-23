// Behavioral tests for the generated dom-patch classes: run them against a real
// DOM (jsdom) and assert the child-range patch actually mutates the document.
//
// This test deliberately does NOT import the compiler. jsdom requires parse5 as
// CommonJS, and the compiler pulls parse5 (via parse5-html-rewriting-stream) as
// an ES module; loading both in one Deno test triggers a require()-cycle error.
// The compiler → AST → marker-comment path is covered in nodes2patch_test.ts;
// here we hand-build the generated classes and the server HTML they expect.
import { assertEquals } from "jsr:@std/assert";
import { JSDOM } from "npm:jsdom";

import type { ElementTNode, IfBranch, IfTNode, PrintTNode } from "../../types.ts";
import { interpretBackcode } from "../../backcode.ts";
import { render } from "../../../runtime/js/render.ts";
import type { BackcodeSite, IfSetSite } from "./collect.ts";
import { generateClassForPartial, type BfidSite, type IfSetPatchSite, type PatchBranch, type PatchTarget } from "./codegen.ts";

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

function patchBranch(className: string, sites: BfidSite[] = [], sets: IfSetPatchSite[] = []): PatchBranch {
	return { className, sites, sets, vars: computeVars(sites, sets) };
}

function printSite(target: PatchTarget, code: string, startId: string, endId: string): BfidSite {
	const node: PrintTNode = { type: 'print', data: interpretBackcode(code) };
	const backcode: BackcodeSite = {
		site: { kind: 'print', node, container: [node], parentElement: null },
		parsed: interpretBackcode(code),
		liveVars: interpretBackcode(code).vars,
		otherVars: [],
		inForLoop: false,
	};
	return { target, backcode, comments: { startId, endId } };
}

function attrSite(bfid: string, name: string, code: string): BfidSite {
	const attr = { type: 'dynamic' as const, name, expr: interpretBackcode(code), isBoolean: false };
	const element: ElementTNode = { type: 'element', tagName: 'div', attrs: [attr], tnodes: [] };
	const backcode: BackcodeSite = {
		site: { kind: 'attr', element, attr },
		parsed: attr.expr, liveVars: attr.expr.vars, otherVars: [], inForLoop: false,
	};
	return { target: { kind: 'bfid-element', bfid }, backcode };
}

// Hand-build the codegen input for an if-set. `conditions` are the branch
// expressions (null = b-else); `snapshot` is the RNode literal the generated module
// would carry as `bfif_<setId>`; `branches` are the per-branch child patch-branches
// (null when a branch owns nothing patchable).
function ifSite(opts: {
	target: PatchTarget;
	conditions: (string | null)[];
	liveVars: string[];
	setId: string;
	endId: string;
	snapshot: string;
	subtreeVars?: string[];
	branches?: (PatchBranch | null)[];
}): IfSetPatchSite {
	const brs: IfBranch[] = opts.conditions.map(c =>
		c === null ? { tnodes: [] } : { condition: interpretBackcode(c), tnodes: [] });
	const node: IfTNode = { type: 'if', branches: brs };
	const set: IfSetSite = {
		kind: 'if-set', node, container: [node], parentElement: null,
		liveVars: opts.liveVars, otherVars: [], inForLoop: false,
	};
	return {
		target: opts.target, ifSet: set, setId: opts.setId, endId: opts.endId, snapshot: opts.snapshot,
		subtreeVars: opts.subtreeVars ?? [],
		branches: opts.branches ?? opts.conditions.map(() => null),
	};
}

// Instantiate the generated cluster's shell class against a host built from
// `innerHtml`, with globalThis.document pointed at the jsdom document for the
// duration. `render` is injected the way the generated module's
// `import { render } from './render.js'` would supply it.
function mount(js: string, partialName: string, className: string, hostAttrs: string, innerHtml: string) {
	const dom = new JSDOM(`<!DOCTYPE html><body><${partialName} ${hostAttrs}>${innerHtml}</${partialName}></body>`);
	const prevDoc = (globalThis as any).document;
	(globalThis as any).document = dom.window.document;
	const host = dom.window.document.querySelector(partialName)!;
	const Cls = new Function('render', js.replaceAll('export class', 'class') + `; return ${className};`)(render);
	const instance = new Cls(host);
	return { host, instance, restore: () => { (globalThis as any).document = prevDoc; } };
}

// --- attr / print (single patch-branch) ------------------------------------

Deno.test("exec: updating a b-attr re-renders the print text, preserving siblings", () => {
	const root = patchBranch('BackflipPatch_MyWidget',
		[printSite({ kind: 'bfid-element', bfid: 'bf0' }, 'name', 'bf1', 'bf2')]);
	const js = generateClassForPartial('my-widget', [{ name: 'name', isBool: false }], root)!;
	const innerHtml = `<p data-bfid="bf0">Hello <!--bfid:bf1-->World<!--bfid:bf2-->!</p>`;
	const { host, instance, restore } = mount(js, 'my-widget', 'BackflipMyWidget', 'name="World"', innerHtml);
	try {
		const p = host.querySelector('p')!;
		assertEquals(p.textContent, 'Hello World!');

		host.setAttribute('name', 'Mars');
		instance.update('name');
		assertEquals(p.textContent, 'Hello Mars!');

		// Markers survive, so repeated updates keep working.
		const comments = [...p.childNodes].filter((n: any) => n.nodeType === 8).map((n: any) => n.nodeValue);
		assertEquals(comments, ['bfid:bf1', 'bfid:bf2']);

		host.setAttribute('name', '');
		instance.update('name');
		assertEquals(p.textContent, 'Hello !');
	} finally {
		restore();
	}
});

Deno.test("exec: print anchored to the ref element patches host children", () => {
	const root = patchBranch('BackflipPatch_MyThing',
		[printSite({ kind: 'ref-element' }, 'label', 'bf0', 'bf1')]);
	const js = generateClassForPartial('my-thing', [{ name: 'label', isBool: false }], root)!;
	const innerHtml = `<!--bfid:bf0-->one<!--bfid:bf1-->`;
	const { host, instance, restore } = mount(js, 'my-thing', 'BackflipMyThing', 'label="one"', innerHtml);
	try {
		assertEquals(host.textContent, 'one');
		host.setAttribute('label', 'two');
		instance.update('label');
		assertEquals(host.textContent, 'two');
	} finally {
		restore();
	}
});

Deno.test("exec: inserted value is text, never interpreted as HTML", () => {
	const root = patchBranch('BackflipPatch_MyWidget',
		[printSite({ kind: 'bfid-element', bfid: 'bf0' }, 'name', 'bf1', 'bf2')]);
	const js = generateClassForPartial('my-widget', [{ name: 'name', isBool: false }], root)!;
	const innerHtml = `<p data-bfid="bf0"><!--bfid:bf1-->plain<!--bfid:bf2--></p>`;
	const { host, instance, restore } = mount(js, 'my-widget', 'BackflipMyWidget', 'name="plain"', innerHtml);
	try {
		const p = host.querySelector('p')!;
		host.setAttribute('name', '<b>x</b>');
		instance.update('name');
		assertEquals(p.querySelector('b'), null);          // not parsed as markup
		assertEquals(p.textContent, '<b>x</b>');           // literal text
	} finally {
		restore();
	}
});

Deno.test("exec: a print and an attr on the same element update together", () => {
	const root = patchBranch('BackflipPatch_MyWidget', [
		attrSite('bf0', 'title', 'name'),
		printSite({ kind: 'bfid-element', bfid: 'bf0' }, 'name', 'bf1', 'bf2'),
	]);
	const js = generateClassForPartial('my-widget', [{ name: 'name', isBool: false }], root)!;
	const innerHtml = `<p data-bfid="bf0" title="World">Hi <!--bfid:bf1-->World<!--bfid:bf2--></p>`;
	const { host, instance, restore } = mount(js, 'my-widget', 'BackflipMyWidget', 'name="World"', innerHtml);
	try {
		const p = host.querySelector('p')!;
		host.setAttribute('name', 'Mars');
		instance.update('name');
		assertEquals(p.getAttribute('title'), 'Mars');
		assertEquals(p.textContent, 'Hi Mars');
	} finally {
		restore();
	}
});

Deno.test("exec: missing markers log an error and skip without throwing", () => {
	const root = patchBranch('BackflipPatch_MyWidget',
		[printSite({ kind: 'bfid-element', bfid: 'bf0' }, 'name', 'bf1', 'bf2')]);
	const js = generateClassForPartial('my-widget', [{ name: 'name', isBool: false }], root)!;
	// <p> has the bfid but no marker comments (rendered DOM diverged from template).
	const { host, instance, restore } = mount(js, 'my-widget', 'BackflipMyWidget', 'name="World"', `<p data-bfid="bf0">Hello !</p>`);
	const errors: unknown[][] = [];
	const prevErr = console.error;
	console.error = (...args: unknown[]) => { errors.push(args); };
	try {
		host.setAttribute('name', 'Mars');
		instance.update('name'); // must not throw
		assertEquals(errors.length, 1);
		assertEquals(String(errors[0][0]).includes('comment markers not found'), true);
	} finally {
		console.error = prevErr;
		restore();
	}
});

// --- if-sets ---------------------------------------------------------------

// A two-branch set whose first branch contains a patchable print, mirroring what
// the compiler emits: the branch HTML carries the same data-bfid and marker
// comments as the server-rendered output, so it stays patchable after a swap.
const BRANCH_A = `{ type:'raw', raw:'<p data-bfid="p0">Hi ' },
	{ type:'comment', text:'bfid:m0' },
	{ type:'print', data: { fn: function (name) { return name; }, vars: ['name'] } },
	{ type:'comment', text:'bfid:m1' },
	{ type:'raw', raw:'</p>' }`;

const SET_SNAPSHOT = `{ type:'if', branches: [
	{ condition: { fn: function (mode) { return mode == 'a'; }, vars: ['mode'] }, nodes: [ ${BRANCH_A} ] },
	{ condition: undefined, nodes: [ { type:'raw', raw:'<em>none</em>' } ] }
] }`;

const SERVER_HTML_A = `<!--bfid:s0--><p data-bfid="p0">Hi <!--bfid:m0-->World<!--bfid:m1--></p><!--bfid:s1-->`;

// The set sits directly in the custom element, so its target is the ref element
// (the host). `childSites` become the branch's own patch-branch, so branch content
// stays patchable after a swap.
function mountSet(snapshot: string, hostAttrs: string, innerHtml: string, childSites: BfidSite[] = []) {
	const child = childSites.length
		? patchBranch('BackflipPatch_s0_0', childSites)
		: null;
	const set = ifSite({
		target: { kind: 'ref-element' }, conditions: [`mode == 'a'`, null], liveVars: ['mode'],
		setId: 's0', endId: 's1', snapshot, subtreeVars: child ? child.vars : [], branches: [child, null],
	});
	const root = patchBranch('BackflipPatch_MyWidget', [], [set]);
	const js = generateClassForPartial('my-widget',
		[{ name: 'mode', isBool: false }, { name: 'name', isBool: false }], root)!;
	return mount(js, 'my-widget', 'BackflipMyWidget', hostAttrs, innerHtml);
}

Deno.test("exec: constructing the class does not touch the DOM (server already rendered)", () => {
	const { host, restore } = mountSet(SET_SNAPSHOT, 'mode="a" name="World"', SERVER_HTML_A);
	try {
		assertEquals(host.innerHTML, SERVER_HTML_A);
	} finally {
		restore();
	}
});

Deno.test("exec: changing the condition var swaps the branch, and back again", () => {
	const { host, instance, restore } = mountSet(SET_SNAPSHOT, 'mode="a" name="World"', SERVER_HTML_A);
	try {
		host.setAttribute('mode', 'b');
		instance.update('mode');
		assertEquals(host.querySelector('p'), null);
		assertEquals(host.querySelector('em')!.textContent, 'none');

		host.setAttribute('mode', 'a');
		instance.update('mode');
		assertEquals(host.querySelector('em'), null);
		assertEquals(host.querySelector('p')!.textContent, 'Hi World');

		// Markers survive every swap, so the range stays patchable.
		const comments = [...host.childNodes].filter((n: any) => n.nodeType === 8).map((n: any) => n.nodeValue);
		assertEquals(comments, ['bfid:s0', 'bfid:s1']);
	} finally {
		restore();
	}
});

Deno.test("exec: an unchanged branch index does not re-render", () => {
	const { host, instance, restore } = mountSet(SET_SNAPSHOT, 'mode="a" name="World"', SERVER_HTML_A);
	try {
		const p = host.querySelector('p')!;
		host.setAttribute('mode', 'a');   // still branch 0
		instance.update('mode');
		assertEquals(host.querySelector('p'), p);   // same node — never replaced
	} finally {
		restore();
	}
});

Deno.test("exec: a set with no b-else renders nothing when no branch matches", () => {
	const snapshot = `{ type:'if', branches: [
		{ condition: { fn: function (mode) { return mode == 'a'; }, vars: ['mode'] }, nodes: [ { type:'raw', raw:'<p>shown</p>' } ] }
	] }`;
	const set = ifSite({
		target: { kind: 'ref-element' }, conditions: [`mode == 'a'`], liveVars: ['mode'],
		setId: 's0', endId: 's1', snapshot, branches: [null],
	});
	const root = patchBranch('BackflipPatch_MyWidget', [], [set]);
	const js = generateClassForPartial('my-widget', [{ name: 'mode', isBool: false }], root)!;
	const { host, instance, restore } = mount(js, 'my-widget', 'BackflipMyWidget', 'mode="a"', `<!--bfid:s0--><p>shown</p><!--bfid:s1-->`);
	try {
		host.setAttribute('mode', 'z');
		instance.update('mode');
		assertEquals(host.querySelector('p'), null);
		assertEquals(host.textContent, '');

		host.setAttribute('mode', 'a');
		instance.update('mode');
		assertEquals(host.querySelector('p')!.textContent, 'shown');
	} finally {
		restore();
	}
});

Deno.test("exec: a print site inside a re-rendered branch still patches (eviction + recreate)", () => {
	// Swapping away deletes the branch's child instance; swapping back creates a fresh
	// one, against which the print inside the freshly rendered branch stays patchable.
	const print = printSite({ kind: 'bfid-element', bfid: 'p0' }, 'name', 'm0', 'm1');
	const { host, instance, restore } = mountSet(SET_SNAPSHOT, 'mode="a" name="World"', SERVER_HTML_A, [print]);
	try {
		host.setAttribute('mode', 'b');
		instance.update('mode');
		host.setAttribute('mode', 'a');
		instance.update('mode');
		assertEquals(host.querySelector('p')!.textContent, 'Hi World');

		host.setAttribute('name', 'Mars');
		instance.update('name');
		assertEquals(host.querySelector('p')!.textContent, 'Hi Mars');
	} finally {
		restore();
	}
});

Deno.test("exec: patching inside an already-rendered branch (no swap) via forwarding", () => {
	// `name` never changes the branch; the update forwards straight into the active
	// child, which patches the live print — no re-render involved.
	const print = printSite({ kind: 'bfid-element', bfid: 'p0' }, 'name', 'm0', 'm1');
	const { host, instance, restore } = mountSet(SET_SNAPSHOT, 'mode="a" name="World"', SERVER_HTML_A, [print]);
	try {
		const p = host.querySelector('p')!;
		host.setAttribute('name', 'Mars');
		instance.update('name');
		assertEquals(host.querySelector('p'), p);              // same node — never re-rendered
		assertEquals(p.textContent, 'Hi Mars');                // but patched in place
	} finally {
		restore();
	}
});

Deno.test("exec: re-rendering uses all live vars, not just the one that changed", () => {
	const print = printSite({ kind: 'bfid-element', bfid: 'p0' }, 'name', 'm0', 'm1');
	const { host, instance, restore } = mountSet(SET_SNAPSHOT, 'mode="a" name="World"', SERVER_HTML_A, [print]);
	try {
		// `name` changes while the branch is inactive; the swap back must pick it up.
		host.setAttribute('mode', 'b');
		instance.update('mode');
		host.setAttribute('name', 'Mars');
		host.setAttribute('mode', 'a');
		instance.update('mode');
		assertEquals(host.querySelector('p')!.textContent, 'Hi Mars');
	} finally {
		restore();
	}
});

// --- nested if-sets --------------------------------------------------------

// Outer set on `mode`; its 'a' branch holds a nested set on `sub`, whose 'x' branch
// holds a print of `label`. Markers: outer s0/s1, inner m0/m1, print pm0/pm1.
const INNER_SNAPSHOT = `{ type:'if', branches: [
	{ condition: { fn: function (sub) { return sub == 'x'; }, vars: ['sub'] }, nodes: [
		{ type:'raw', raw:'<p data-bfid="p0">Hi ' },
		{ type:'comment', text:'bfid:pm0' },
		{ type:'print', data: { fn: function (label) { return label; }, vars: ['label'] } },
		{ type:'comment', text:'bfid:pm1' },
		{ type:'raw', raw:'</p>' }
	] },
	{ condition: undefined, nodes: [ { type:'raw', raw:'<em>no</em>' } ] }
] }`;

const OUTER_SNAPSHOT = `{ type:'if', branches: [
	{ condition: { fn: function (mode) { return mode == 'a'; }, vars: ['mode'] }, nodes: [
		{ type:'comment', text:'bfid:m0' },
		${INNER_SNAPSHOT},
		{ type:'comment', text:'bfid:m1' }
	] },
	{ condition: undefined, nodes: [ { type:'raw', raw:'<span>B</span>' } ] }
] }`;

const NESTED_SERVER_HTML =
	`<!--bfid:s0--><!--bfid:m0--><p data-bfid="p0">Hi <!--bfid:pm0-->L<!--bfid:pm1--></p><!--bfid:m1--><!--bfid:s1-->`;

function mountNested(hostAttrs: string) {
	const printChild = patchBranch('BackflipPatch_m0_0',
		[printSite({ kind: 'bfid-element', bfid: 'p0' }, 'label', 'pm0', 'pm1')]);
	const innerSet = ifSite({
		target: { kind: 'ref-element' }, conditions: [`sub == 'x'`, null], liveVars: ['sub'],
		setId: 'm0', endId: 'm1', snapshot: INNER_SNAPSHOT, subtreeVars: ['label'], branches: [printChild, null],
	});
	const outerChild = patchBranch('BackflipPatch_s0_0', [], [innerSet]);
	const outerSet = ifSite({
		target: { kind: 'ref-element' }, conditions: [`mode == 'a'`, null], liveVars: ['mode'],
		setId: 's0', endId: 's1', snapshot: OUTER_SNAPSHOT, subtreeVars: ['sub', 'label'], branches: [outerChild, null],
	});
	const root = patchBranch('BackflipPatch_MyWidget', [], [outerSet]);
	const js = generateClassForPartial('my-widget',
		[{ name: 'mode', isBool: false }, { name: 'sub', isBool: false }, { name: 'label', isBool: false }], root)!;
	return mount(js, 'my-widget', 'BackflipMyWidget', hostAttrs, NESTED_SERVER_HTML);
}

Deno.test("exec: a var live only in a deep branch forwards all the way down and patches", () => {
	const { host, instance, restore } = mountNested('mode="a" sub="x" label="L"');
	try {
		assertEquals(host.querySelector('p')!.textContent, 'Hi L');
		host.setAttribute('label', 'Mars');
		instance.update('label');
		assertEquals(host.querySelector('p')!.textContent, 'Hi Mars');
	} finally {
		restore();
	}
});

Deno.test("exec: changing a nested condition swaps only the inner branch", () => {
	const { host, instance, restore } = mountNested('mode="a" sub="x" label="L"');
	try {
		host.setAttribute('sub', 'y');
		instance.update('sub');
		assertEquals(host.querySelector('p'), null);
		assertEquals(host.querySelector('em')!.textContent, 'no');

		// The outer branch (mode) is untouched; swapping the inner condition back restores it.
		host.setAttribute('sub', 'x');
		instance.update('sub');
		assertEquals(host.querySelector('em'), null);
		assertEquals(host.querySelector('p')!.textContent, 'Hi L');
	} finally {
		restore();
	}
});

Deno.test("exec: swapping the outer branch and back re-establishes the deep patch path", () => {
	const { host, instance, restore } = mountNested('mode="a" sub="x" label="L"');
	try {
		host.setAttribute('mode', 'b');
		instance.update('mode');
		assertEquals(host.querySelector('span')!.textContent, 'B');
		assertEquals(host.querySelector('p'), null);

		host.setAttribute('mode', 'a');
		instance.update('mode');
		// Fresh child chain rebuilt; the deep print is patchable again.
		host.setAttribute('label', 'Deep');
		instance.update('label');
		assertEquals(host.querySelector('p')!.textContent, 'Hi Deep');
	} finally {
		restore();
	}
});
