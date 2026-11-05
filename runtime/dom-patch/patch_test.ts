import { assertEquals } from "jsr:@std/assert";
import { JSDOM } from "npm:jsdom";

import { BackflipElement, BackflipShell, PatchBranch, replaceBetween, type BranchDesc, type ItemRange, type LoopDesc, type SetDesc } from "./patch.ts";
import { enqueue, flush, storeChanged } from "./flush.ts";
import type { ForRNode, IfRNode, rfn } from "../js/render.ts";

function parentWith(innerHtml: string) {
	const dom = new JSDOM(`<!DOCTYPE html><body><div>${innerHtml}</div></body>`);
	const doc = dom.window.document;
	return { doc, parent: doc.querySelector('div')! };
}

function comments(parent: Node): string[] {
	return [...parent.childNodes].filter(n => n.nodeType === 8).map(n => n.nodeValue!);
}

Deno.test("replaceBetween: replaces the range, keeping siblings and markers", () => {
	const { doc, parent } = parentWith(`before<!--a-->old<b>x</b>old<!--b-->after`);
	replaceBetween(parent, 'a', 'b', doc.createTextNode('new'));
	assertEquals(parent.innerHTML, 'before<!--a-->new<!--b-->after');
	assertEquals(comments(parent), ['a', 'b']);
});

Deno.test("replaceBetween: fills an empty range", () => {
	const { doc, parent } = parentWith(`<!--a--><!--b-->`);
	replaceBetween(parent, 'a', 'b', doc.createTextNode('v'));
	assertEquals(parent.innerHTML, '<!--a-->v<!--b-->');
});

Deno.test("replaceBetween: inserts every node of a fragment", () => {
	const { doc, parent } = parentWith(`<!--a-->old<!--b-->`);
	const frag = doc.createDocumentFragment();
	frag.append(doc.createElement('i'), doc.createTextNode('t'));
	replaceBetween(parent, 'a', 'b', frag);
	assertEquals(parent.innerHTML, '<!--a--><i></i>t<!--b-->');
});

Deno.test("replaceBetween: repeated calls keep working on the same range", () => {
	const { doc, parent } = parentWith(`<!--a-->1<!--b-->`);
	replaceBetween(parent, 'a', 'b', doc.createTextNode('2'));
	replaceBetween(parent, 'a', 'b', doc.createTextNode('3'));
	assertEquals(parent.innerHTML, '<!--a-->3<!--b-->');
});

Deno.test("replaceBetween: leaves other marker ranges alone", () => {
	const { doc, parent } = parentWith(`<!--a-->1<!--b--><!--c-->2<!--d-->`);
	replaceBetween(parent, 'c', 'd', doc.createTextNode('x'));
	assertEquals(parent.innerHTML, '<!--a-->1<!--b--><!--c-->x<!--d-->');
});

Deno.test("replaceBetween: only matches direct children", () => {
	const { doc, parent } = parentWith(`<p><!--a-->1<!--b--></p>`);
	const errors: unknown[][] = [];
	const orig = console.error;
	console.error = (...args: unknown[]) => { errors.push(args); };
	try {
		replaceBetween(parent, 'a', 'b', doc.createTextNode('x'));
	} finally {
		console.error = orig;
	}
	assertEquals(parent.innerHTML, '<p><!--a-->1<!--b--></p>');
	assertEquals(errors.length, 1);
});

for (const [label, html] of [
	['start', `old<!--b-->`],
	['end', `<!--a-->old`],
	['both', `old`],
] as const) {
	Deno.test(`replaceBetween: a missing ${label} marker logs and changes nothing`, () => {
		const { doc, parent } = parentWith(html);
		const errors: unknown[][] = [];
		const orig = console.error;
		console.error = (...args: unknown[]) => { errors.push(args); };
		try {
			replaceBetween(parent, 'a', 'b', doc.createTextNode('new'));
		} finally {
			console.error = orig;
		}
		assertEquals(parent.innerHTML, html);
		assertEquals(errors.length, 1);
		assertEquals(String(errors[0][0]).includes('comment markers a / b not found'), true);
		assertEquals(errors[0][1], parent);
	});
}

for (const [label, html] of [
	['start', `<!--a-->old<!--b--><!--a-->`],
	['end', `<!--b--><!--a-->old<!--b-->`],
	['pair', `<!--a-->one<!--b--><!--a-->two<!--b-->`],
] as const) {
	Deno.test(`replaceBetween: a repeated ${label} marker logs and changes nothing`, () => {
		const { doc, parent } = parentWith(html);
		const { errors } = captureErrors(() => replaceBetween(parent, 'a', 'b', doc.createTextNode('new')));
		assertEquals(parent.innerHTML, html);
		assertEquals(errors.length, 1);
		assertEquals(String(errors[0][0]).includes('comment markers a / b found more than once'), true);
		assertEquals(errors[0][1], parent);
	});
}

// --- PatchBranch ------------------------------------------------------------

function expr(code: string, vars: string[]): rfn {
	return { fn: new Function(...vars, `return ${code};`) as (...args: any[]) => any, vars };
}

// A host element holding `innerHtml`, and a way to capture console.error calls.
function host(innerHtml: string) {
	const dom = new JSDOM(`<!DOCTYPE html><body><my-el>${innerHtml}</my-el></body>`);
	const doc = dom.window.document;
	return { doc, el: doc.querySelector('my-el')! };
}

function captureErrors<T>(f: () => T): { result: T, errors: unknown[][] } {
	const errors: unknown[][] = [];
	const orig = console.error;
	console.error = (...args: unknown[]) => { errors.push(args); };
	try {
		return { result: f(), errors };
	} finally {
		console.error = orig;
	}
}

Deno.test("PatchBranch: an attr site is set from its expression", () => {
	const { el } = host(`<p data-bfid="p">x</p>`);
	const pb = new PatchBranch({ sites: [{ bfid: 'p', attr: 'title', expr: expr('a + "-" + b', ['a', 'b']) }], sets: [] }, el, {});
	pb.update({ a: 1, b: 2 });
	assertEquals(el.querySelector('p')!.getAttribute('title'), '1-2');
});

Deno.test("PatchBranch: a bool attr site is present or absent", () => {
	const { el } = host(`<p data-bfid="p">x</p>`);
	const pb = new PatchBranch({ sites: [{ bfid: 'p', attr: 'hidden', bool: true, expr: expr('on', ['on']) }], sets: [] }, el, {});
	pb.update({ on: true });
	assertEquals(el.querySelector('p')!.getAttribute('hidden'), '');
	pb.update({ on: false });
	assertEquals(el.querySelector('p')!.hasAttribute('hidden'), false);
});

Deno.test("PatchBranch: a print site replaces its marker range with text, never markup", () => {
	const { el } = host(`<p data-bfid="p">Hi <!--m0-->x<!--m1-->!</p>`);
	const pb = new PatchBranch({ sites: [{ bfid: 'p', markers: ['m0', 'm1'], expr: expr('name', ['name']) }], sets: [] }, el, {});
	pb.update({ name: '<b>Mars</b>' });
	const p = el.querySelector('p')!;
	assertEquals(p.textContent, 'Hi <b>Mars</b>!');
	assertEquals(p.querySelector('b'), null);
	assertEquals(p.innerHTML, 'Hi <!--m0-->&lt;b&gt;Mars&lt;/b&gt;<!--m1-->!');
});

Deno.test("PatchBranch: a null bfid targets the ref element itself", () => {
	const { el } = host(`<!--m0-->x<!--m1-->`);
	const pb = new PatchBranch({ sites: [
		{ bfid: null, attr: 'class', expr: expr('c', ['c']) },
		{ bfid: null, markers: ['m0', 'm1'], expr: expr('c', ['c']) },
	], sets: [] }, el, {});
	pb.update({ c: 'on' });
	assertEquals(el.getAttribute('class'), 'on');
	assertEquals(el.textContent, 'on');
});

Deno.test("PatchBranch: a site whose value is unchanged does not look up its element", () => {
	const { el } = host(`<p data-bfid="p">x</p>`);
	const pb = new PatchBranch({ sites: [{ bfid: 'p', attr: 'title', expr: expr('v', ['v']) }], sets: [] }, el, {});
	pb.update({ v: 'x' });
	let lookups = 0;
	const orig = el.querySelector.bind(el);
	(el as any).querySelector = (sel: string) => { lookups++; return orig(sel); };
	pb.update({ v: 'x' });
	assertEquals(lookups, 0);
});

Deno.test("PatchBranch: only the sites whose value changed are written", () => {
	const { el } = host(`<p data-bfid="p" title="T"><!--m0-->N<!--m1--></p>`);
	const pb = new PatchBranch({ sites: [
		{ bfid: 'p', attr: 'title', expr: expr('w.title', ['w']) },
		{ bfid: 'p', markers: ['m0', 'm1'], expr: expr('w.name', ['w']) },
	], sets: [] }, el, {});
	pb.update({ w: { title: 'T', name: 'N' } });
	const records = mutations(el, () => pb.update({ w: { title: 'U', name: 'N' } }));
	assertEquals(records.map(r => r.type), ['attributes']);
});

Deno.test("PatchBranch: a set that keeps its branch updates that branch, without re-rendering", () => {
	const { el } = host(SERVER_A);
	const pb = new PatchBranch({ sites: [], sets: [SET] }, el, { mode: 'a', name: 'World' });
	const p = el.querySelector('p');
	pb.update({ mode: 'a', name: 'Mars' });
	assertEquals(el.querySelector('p'), p);
	assertEquals(p!.textContent, 'Hi Mars');
});

Deno.test("PatchBranch: a missing element is reported and the other sites still patch", () => {
	const { el } = host(`<p data-bfid="p">x</p>`);
	const pb = new PatchBranch({ sites: [
		{ bfid: 'gone', attr: 'title', expr: expr('v', ['v']) },
		{ bfid: 'p', attr: 'title', expr: expr('v', ['v']) },
	], sets: [] }, el, {});
	const { errors } = captureErrors(() => pb.update({ v: 'x' }));
	assertEquals(errors.length, 1);
	assertEquals(String(errors[0][0]).includes('[data-bfid="gone"] not found'), true);
	assertEquals(el.querySelector('p')!.getAttribute('title'), 'x');
});

// A set directly in the host on `mode`: branch 0 (`mode == 'a'`) prints `name` and
// has its own patch-branch; branch 1 is a b-else with nothing to patch. Each branch
// opens with its branch marker (`b0`, `b1`).
const SET_SNAPSHOT: IfRNode = { type: 'if', branches: [
	{ condition: expr("mode == 'a'", ['mode']), nodes: [
		{ type: 'comment', text: 'b0' },
		{ type: 'raw', raw: '<p data-bfid="p">Hi ' },
		{ type: 'comment', text: 'n0' },
		{ type: 'print', data: expr('name', ['name']) },
		{ type: 'comment', text: 'n1' },
		{ type: 'raw', raw: '</p>' },
	] },
	{ nodes: [{ type: 'comment', text: 'b1' }, { type: 'raw', raw: '<em>none</em>' }] },
] };
const BRANCH_A: BranchDesc = { sites: [{ bfid: 'p', markers: ['n0', 'n1'], expr: expr('name', ['name']) }], sets: [] };
const SET: SetDesc = {
	bfid: null, markers: ['s0', 's1'], snapshot: SET_SNAPSHOT,
	branches: [BRANCH_A, null], branchMarkers: ['b0', 'b1'],
};
const SERVER_A = `<!--s0--><!--b0--><p data-bfid="p">Hi <!--n0-->World<!--n1--></p><!--s1-->`;
const SERVER_ELSE = `<!--s0--><!--b1--><em>none</em><!--s1-->`;
// SET without its b-else: nothing renders when `mode` isn't 'a'.
const SET_NO_ELSE: SetDesc = {
	...SET, snapshot: { type: 'if', branches: [SET_SNAPSHOT.branches[0]] }, branches: [BRANCH_A], branchMarkers: ['b0'],
};
const SERVER_NONE = `<!--s0--><!--s1-->`;

Deno.test("PatchBranch: constructing does not touch the DOM", () => {
	const { el } = host(SERVER_A);
	new PatchBranch({ sites: [], sets: [SET] }, el, { mode: 'a', name: 'World' });
	assertEquals(el.innerHTML, SERVER_A);
});

Deno.test("PatchBranch: a change of winning branch swaps it, and back, keeping the markers", () => {
	const { el } = host(SERVER_A);
	const pb = new PatchBranch({ sites: [], sets: [SET] }, el, { mode: 'a', name: 'World' });
	pb.update({ mode: 'b', name: 'World' });
	assertEquals(el.querySelector('p'), null);
	assertEquals(el.querySelector('em')!.textContent, 'none');
	pb.update({ mode: 'a', name: 'World' });
	assertEquals(el.querySelector('p')!.textContent, 'Hi World');
	const comments = [...el.childNodes].filter(n => n.nodeType === 8).map(n => n.nodeValue);
	assertEquals(comments, ['s0', 'b0', 's1']);
});

Deno.test("PatchBranch: an unchanged winning branch is not re-rendered", () => {
	const { el } = host(SERVER_A);
	const pb = new PatchBranch({ sites: [], sets: [SET] }, el, { mode: 'a', name: 'World' });
	const p = el.querySelector('p');
	pb.update({ mode: 'a', name: 'World' });
	assertEquals(el.querySelector('p'), p);
});

Deno.test("PatchBranch: with no b-else and no match, the set renders nothing", () => {
	const { el } = host(SERVER_A);
	const pb = new PatchBranch({ sites: [], sets: [SET_NO_ELSE] }, el, { mode: 'a', name: 'W' });
	pb.update({ mode: 'z', name: 'W' });
	assertEquals(el.innerHTML, SERVER_NONE);
});

Deno.test("PatchBranch: a swapped-in branch gets a fresh patch-branch that keeps patching", () => {
	const { el } = host(SERVER_A);
	const pb = new PatchBranch({ sites: [], sets: [SET] }, el, { mode: 'a', name: 'World' });
	pb.update({ mode: 'b', name: 'World' });
	// Changed while its branch is out: nothing to update.
	pb.update({ mode: 'b', name: 'Mars' });
	pb.update({ mode: 'a', name: 'Mars' });
	assertEquals(el.querySelector('p')!.textContent, 'Hi Mars');
	pb.update({ mode: 'a', name: 'Venus' });
	assertEquals(el.querySelector('p')!.textContent, 'Hi Venus');
});

Deno.test("PatchBranch: a var in both the conditions and the subtree re-renders or patches in place", () => {
	// `mode` picks the branch and is also printed inside it.
	const snapshot: IfRNode = { type: 'if', branches: [
		{ condition: expr("mode != 'off'", ['mode']), nodes: [
			{ type: 'comment', text: 'b0' },
			{ type: 'raw', raw: '<p data-bfid="p">' },
			{ type: 'comment', text: 'n0' },
			{ type: 'print', data: expr('mode', ['mode']) },
			{ type: 'comment', text: 'n1' },
			{ type: 'raw', raw: '</p>' },
		] },
		{ nodes: [{ type: 'comment', text: 'b1' }, { type: 'raw', raw: '<em>off</em>' }] },
	] };
	const branch: BranchDesc = { sites: [{ bfid: 'p', markers: ['n0', 'n1'], expr: expr('mode', ['mode']) }], sets: [] };
	const set: SetDesc = { bfid: null, markers: ['s0', 's1'], snapshot, branches: [branch, null], branchMarkers: ['b0', 'b1'] };
	const { el } = host(`<!--s0--><!--b0--><p data-bfid="p"><!--n0-->x<!--n1--></p><!--s1-->`);
	const pb = new PatchBranch({ sites: [], sets: [set] }, el, { mode: 'x' });
	const p = el.querySelector('p');
	// Same branch: patched in place.
	pb.update({ mode: 'y' });
	assertEquals(el.querySelector('p'), p);
	assertEquals(p!.textContent, 'y');
	// Different branch: re-rendered.
	pb.update({ mode: 'off' });
	assertEquals(el.querySelector('em')!.textContent, 'off');
});

// An outer set on `on` whose first branch holds a <div> with an inner set on `sub`.
const INNER: IfRNode = { type: 'if', branches: [
	{ condition: expr("sub == 'x'", ['sub']), nodes: [{ type: 'comment', text: 'ib0' }, { type: 'raw', raw: '<b>X</b>' }] },
	{ nodes: [{ type: 'comment', text: 'ib1' }, { type: 'raw', raw: '<i>Y</i>' }] },
] };
const OUTER: IfRNode = { type: 'if', branches: [
	{ condition: expr('on', ['on']), nodes: [
		{ type: 'comment', text: 'ob0' },
		{ type: 'raw', raw: '<div data-bfid="d">' }, { type: 'comment', text: 'i0' }, INNER, { type: 'comment', text: 'i1' }, { type: 'raw', raw: '</div>' },
	] },
	{ nodes: [{ type: 'comment', text: 'ob1' }] },
] };
const INNER_SET: SetDesc = { bfid: 'd', markers: ['i0', 'i1'], snapshot: INNER, branches: [null, null], branchMarkers: ['ib0', 'ib1'] };
const OUTER_SET: SetDesc = {
	bfid: null, markers: ['o0', 'o1'], snapshot: OUTER,
	branches: [{ sites: [], sets: [INNER_SET] }, null], branchMarkers: ['ob0', 'ob1'],
};

Deno.test("PatchBranch: a nested set swaps only its own range", () => {
	const { el } = host(`<!--o0--><!--ob0--><div data-bfid="d"><!--i0--><!--ib0--><b>X</b><!--i1--></div><!--o1-->`);
	const pb = new PatchBranch({ sites: [], sets: [OUTER_SET] }, el, { on: true, sub: 'x' });
	const div = el.querySelector('div');
	pb.update({ on: true, sub: 'y' });
	assertEquals(el.querySelector('div'), div);   // the outer branch stayed
	assertEquals(div!.innerHTML, '<!--i0--><!--ib1--><i>Y</i><!--i1-->');
});

// --- PatchBranch: an expression that throws stays local ---------------------
//
// `w.name` throws when `w` is undefined, as a lookup of a removed entry does.

const THROWING_SITES: { label: string, html: string, site: BranchDesc['sites'][number], good: string, empty: string }[] = [
	{ label: 'a print goes empty', html: `<p data-bfid="p"><!--m0-->A<!--m1--></p>`,
		site: { bfid: 'p', markers: ['m0', 'm1'], expr: expr('w.name', ['w']) },
		good: `<p data-bfid="p"><!--m0-->B<!--m1--></p>`, empty: `<p data-bfid="p"><!--m0--><!--m1--></p>` },
	{ label: 'an attr goes empty', html: `<p data-bfid="p" title="A"></p>`,
		site: { bfid: 'p', attr: 'title', expr: expr('w.name', ['w']) },
		good: `<p data-bfid="p" title="B"></p>`, empty: `<p data-bfid="p" title=""></p>` },
	{ label: 'a bool attr is removed', html: `<p data-bfid="p" hidden=""></p>`,
		site: { bfid: 'p', attr: 'hidden', bool: true, expr: expr('w.name', ['w']) },
		good: `<p data-bfid="p" hidden=""></p>`, empty: `<p data-bfid="p"></p>` },
];
for (const c of THROWING_SITES) {
	Deno.test(`PatchBranch: when its expression throws, ${c.label}, is reported, and recovers`, () => {
		const { el } = host(c.html);
		const pb = new PatchBranch({ sites: [c.site], sets: [] }, el, {});
		const { errors } = captureErrors(() => pb.update({ w: undefined }));
		assertEquals(errors.length, 1);
		assertEquals(el.innerHTML, c.empty);
		pb.update({ w: { name: 'B' } });
		assertEquals(el.innerHTML, c.good);
	});
}

Deno.test("PatchBranch: a throwing site does not stop the sites after it", () => {
	const { el } = host(`<p data-bfid="p"><!--m0-->A<!--m1--><!--m2-->A<!--m3--></p>`);
	const pb = new PatchBranch({ sites: [
		{ bfid: 'p', markers: ['m0', 'm1'], expr: expr('w.name', ['w']) },
		{ bfid: 'p', markers: ['m2', 'm3'], expr: expr('v', ['v']) },
	], sets: [] }, el, {});
	captureErrors(() => pb.update({ w: undefined, v: 'B' }));
	assertEquals(el.querySelector('p')!.textContent, 'B');
});

// SET with its condition reading through `w`: it throws when `w` is undefined.
const THROWING_COND: SetDesc = {
	...SET,
	snapshot: { ...SET_SNAPSHOT, branches: [{ ...SET_SNAPSHOT.branches[0], condition: expr("w.mode == 'a'", ['w']) }, SET_SNAPSHOT.branches[1]] },
};
// SET with branch 1's content reading through `w`: rendering it throws when `w` is undefined.
const THROWING_BRANCH: SetDesc = {
	...SET,
	snapshot: { ...SET_SNAPSHOT, branches: [SET_SNAPSHOT.branches[0], { nodes: [{ type: 'comment', text: 'b1' }, { type: 'print', data: expr('w.name', ['w']) }] }] },
};

Deno.test("PatchBranch: a throwing condition keeps the branch and updates it, then recovers", () => {
	const { el } = host(SERVER_A);
	const pb = new PatchBranch({ sites: [], sets: [THROWING_COND] }, el, {});
	const p = el.querySelector('p');
	const { errors } = captureErrors(() => pb.update({ w: undefined, name: 'Mars' }));
	assertEquals(errors.length, 1);
	assertEquals(el.querySelector('p'), p);
	assertEquals(p!.textContent, 'Hi Mars');
	pb.update({ w: { mode: 'b' }, name: 'Mars' });
	assertEquals(el.querySelector('em')!.textContent, 'none');
});

Deno.test("PatchBranch: a throwing branch render keeps the branch and updates it, then recovers", () => {
	const { el } = host(SERVER_A);
	const pb = new PatchBranch({ sites: [], sets: [THROWING_BRANCH] }, el, {});
	const p = el.querySelector('p');
	const { errors } = captureErrors(() => pb.update({ mode: 'b', w: undefined, name: 'Mars' }));
	assertEquals(errors.length, 1);
	assertEquals(el.querySelector('p'), p);
	assertEquals(p!.textContent, 'Hi Mars');
	pb.update({ mode: 'b', w: { name: 'Shown' }, name: 'Mars' });
	assertEquals(el.querySelector('p'), null);
	assertEquals(el.textContent, 'Shown');
});

// --- PatchBranch: the rendered branch is read from the DOM ------------------
//
// Data that changed before the patch-branch was built must not be mistaken for what
// the server rendered.

Deno.test("PatchBranch: DOM on branch 0, data on branch 1: the update renders branch 1", () => {
	const { el } = host(SERVER_A);
	const pb = new PatchBranch({ sites: [], sets: [SET] }, el, { mode: 'b', name: 'World' });
	pb.update({ mode: 'b', name: 'World' });
	assertEquals(el.innerHTML, SERVER_ELSE);
});

Deno.test("PatchBranch: DOM on branch 1, data on branch 0: the update renders branch 0 and it patches", () => {
	const { el } = host(SERVER_ELSE);
	const { errors } = captureErrors(() => {
		const pb = new PatchBranch({ sites: [], sets: [SET] }, el, { mode: 'a', name: 'World' });
		pb.update({ mode: 'a', name: 'World' });
		pb.update({ mode: 'a', name: 'Mars' });
	});
	assertEquals(errors, []);
	assertEquals(el.querySelector('p')!.textContent, 'Hi Mars');
});

Deno.test("PatchBranch: DOM with no branch, data on branch 0: the update renders branch 0", () => {
	const { el } = host(SERVER_NONE);
	const pb = new PatchBranch({ sites: [], sets: [SET_NO_ELSE] }, el, { mode: 'a', name: 'World' });
	pb.update({ mode: 'a', name: 'World' });
	assertEquals(el.querySelector('p')!.textContent, 'Hi World');
});

Deno.test("PatchBranch: DOM on branch 0, data on no branch: the update empties the set", () => {
	const { el } = host(SERVER_A);
	const pb = new PatchBranch({ sites: [], sets: [SET_NO_ELSE] }, el, { mode: 'z', name: 'World' });
	pb.update({ mode: 'z', name: 'World' });
	assertEquals(el.innerHTML, SERVER_NONE);
});

Deno.test("PatchBranch: a nested set reads its own rendered branch from the DOM", () => {
	const { el } = host(`<!--o0--><!--ob0--><div data-bfid="d"><!--i0--><!--ib0--><b>X</b><!--i1--></div><!--o1-->`);
	const pb = new PatchBranch({ sites: [], sets: [OUTER_SET] }, el, { on: true, sub: 'y' });
	pb.update({ on: true, sub: 'y' });
	assertEquals(el.querySelector('div')!.innerHTML, '<!--i0--><!--ib1--><i>Y</i><!--i1-->');
});

Deno.test("PatchBranch: a set whose markers are missing is reported and treated as rendering nothing", () => {
	const { el } = host(`<p data-bfid="p">Hi</p>`);
	const { errors } = captureErrors(() => new PatchBranch({ sites: [], sets: [SET] }, el, { mode: 'a', name: 'W' }));
	assertEquals(errors.length, 1);
	assertEquals(String(errors[0][0]).includes('comment markers s0 / s1 not found'), true);
});

// --- PatchBranch: writes only what changed -----------------------------------

// Every DOM mutation under `el` while `f` runs.
function mutations(el: Element, f: () => void): MutationRecord[] {
	const Observer = el.ownerDocument.defaultView!.MutationObserver;
	const obs = new Observer(() => {});
	obs.observe(el, { subtree: true, childList: true, attributes: true, characterData: true });
	f();
	const records = obs.takeRecords();
	obs.disconnect();
	return records;
}

Deno.test("PatchBranch: a full update whose DOM already matches the data writes nothing", () => {
	const { el } = host(`<p data-bfid="p" title="T" hidden><!--m0-->World<!--m1--></p>${SERVER_A}`);
	const data = { t: 'T', on: true, mode: 'a', name: 'World' };
	const pb = new PatchBranch({ sites: [
		{ bfid: 'p', attr: 'title', expr: expr('t', ['t']) },
		{ bfid: 'p', attr: 'hidden', bool: true, expr: expr('on', ['on']) },
		{ bfid: 'p', markers: ['m0', 'm1'], expr: expr('name', ['name']) },
	], sets: [SET] }, el, data);
	assertEquals(mutations(el, () => pb.update(data)), []);
});

Deno.test("PatchBranch: a full update fixes whatever differs from the data", () => {
	const { el } = host(`<p data-bfid="p" title="T"><!--m0-->World<!--m1--></p>${SERVER_A}`);
	const data = { t: 'U', mode: 'b', name: 'Mars' };
	const pb = new PatchBranch({ sites: [
		{ bfid: 'p', attr: 'title', expr: expr('t', ['t']) },
		{ bfid: 'p', markers: ['m0', 'm1'], expr: expr('name', ['name']) },
	], sets: [SET] }, el, data);
	pb.update(data);
	assertEquals(el.innerHTML, `<p data-bfid="p" title="U"><!--m0-->Mars<!--m1--></p>${SERVER_ELSE}`);
});

Deno.test("PatchBranch: a recomputed value equal to the rendered one writes nothing", () => {
	const { el } = host(`<p data-bfid="p"><!--m0-->true<!--m1--></p>`);
	const pb = new PatchBranch({ sites: [{ bfid: 'p', markers: ['m0', 'm1'], expr: expr('a.length > 3', ['a']) }], sets: [] }, el, {});
	assertEquals(mutations(el, () => pb.update({ a: 'world' })), []);
	pb.update({ a: 'hi' });
	assertEquals(el.textContent, 'false');
});

// Each site kind, rendered as `html`: `same` leaves it untouched, `changed` rewrites it to `after`.
const SITE_CASES: { label: string, html: string, site: BranchDesc['sites'][number], same: unknown, changed: unknown, after: string }[] = [
	{ label: 'a string attr', html: `<p data-bfid="p" title="x"></p>`,
		site: { bfid: 'p', attr: 'title', expr: expr('v', ['v']) }, same: 'x', changed: 'y', after: `<p data-bfid="p" title="y"></p>` },
	{ label: 'a present bool attr', html: `<p data-bfid="p" hidden=""></p>`,
		site: { bfid: 'p', attr: 'hidden', bool: true, expr: expr('v', ['v']) }, same: true, changed: false, after: `<p data-bfid="p"></p>` },
	{ label: 'an absent bool attr', html: `<p data-bfid="p"></p>`,
		site: { bfid: 'p', attr: 'hidden', bool: true, expr: expr('v', ['v']) }, same: false, changed: true, after: `<p data-bfid="p" hidden=""></p>` },
	{ label: 'a print', html: `<p data-bfid="p"><!--m0-->x<!--m1--></p>`,
		site: { bfid: 'p', markers: ['m0', 'm1'], expr: expr('v', ['v']) }, same: 'x', changed: 'y', after: `<p data-bfid="p"><!--m0-->y<!--m1--></p>` },
	{ label: 'an empty print', html: `<p data-bfid="p"><!--m0--><!--m1--></p>`,
		site: { bfid: 'p', markers: ['m0', 'm1'], expr: expr('v', ['v']) }, same: '', changed: 'y', after: `<p data-bfid="p"><!--m0-->y<!--m1--></p>` },
];
for (const c of SITE_CASES) {
	Deno.test(`PatchBranch: ${c.label} is read from the DOM and written only when it changes`, () => {
		const { el } = host(c.html);
		const pb = new PatchBranch({ sites: [c.site], sets: [] }, el, {});
		assertEquals(mutations(el, () => pb.update({ v: c.same })), []);
		pb.update({ v: c.changed });
		assertEquals(el.innerHTML, c.after);
		assertEquals(mutations(el, () => pb.update({ v: c.changed })), []);
	});
}

// The values the server renders no attribute for.
for (const [label, omitted] of [['null', null], ['undefined', undefined], ['false', false]] as const) {
	const site = { bfid: 'p', attr: 'title', expr: expr('v', ['v']) };

	Deno.test(`PatchBranch: an absent attr stays absent for ${label}, with no write`, () => {
		const { el } = host(`<p data-bfid="p"></p>`);
		const pb = new PatchBranch({ sites: [site], sets: [] }, el, {});
		assertEquals(mutations(el, () => pb.update({ v: omitted })), []);
		assertEquals(el.innerHTML, `<p data-bfid="p"></p>`);
		pb.update({ v: 'y' });
		assertEquals(el.innerHTML, `<p data-bfid="p" title="y"></p>`);
	});

	Deno.test(`PatchBranch: an attr is removed when its value becomes ${label}, and can come back`, () => {
		const { el } = host(`<p data-bfid="p" title="x"></p>`);
		const pb = new PatchBranch({ sites: [site], sets: [] }, el, {});
		pb.update({ v: omitted });
		assertEquals(el.innerHTML, `<p data-bfid="p"></p>`);
		assertEquals(mutations(el, () => pb.update({ v: omitted })), []);
		pb.update({ v: 'x' });
		assertEquals(el.innerHTML, `<p data-bfid="p" title="x"></p>`);
	});
}

// Only null, undefined and false omit the attribute; the rest print as the server prints them.
for (const [value, text] of [[0, '0'], ['', ''], [true, 'true']] as const) {
	Deno.test(`PatchBranch: an attr with the value ${JSON.stringify(value)} is written as "${text}"`, () => {
		const { el } = host(`<p data-bfid="p"></p>`);
		const pb = new PatchBranch({ sites: [{ bfid: 'p', attr: 'title', expr: expr('v', ['v']) }], sets: [] }, el, {});
		pb.update({ v: value });
		assertEquals(el.querySelector('p')!.getAttribute('title'), text);
	});
}

Deno.test("PatchBranch: a print still shows null and false as text", () => {
	const { el } = host(`<p data-bfid="p"><!--m0-->x<!--m1--></p>`);
	const pb = new PatchBranch({ sites: [{ bfid: 'p', markers: ['m0', 'm1'], expr: expr('v', ['v']) }], sets: [] }, el, {});
	pb.update({ v: null });
	assertEquals(el.textContent, 'null');
	pb.update({ v: false });
	assertEquals(el.textContent, 'false');
});

Deno.test("PatchBranch: a swapped-in branch reads its rendered DOM, so an unchanged value writes nothing", () => {
	const { el } = host(SERVER_ELSE);
	const pb = new PatchBranch({ sites: [], sets: [SET] }, el, { mode: 'b', name: 'World' });
	pb.update({ mode: 'a', name: 'World' });
	assertEquals(mutations(el, () => pb.update({ mode: 'a', name: 'World' })), []);
});

// --- another instance of the same partial inside this one ---------------------
//
// Instances share their data-bfids, and slot content can hold another instance
// ahead of this one's own elements.

Deno.test("PatchBranch: an attr site skips the same element in a nested instance", () => {
	const { el } = host(`<my-el><p data-bfid="p" title="inner"></p></my-el><p id="own" data-bfid="p" title="outer"></p>`);
	new PatchBranch({ sites: [{ bfid: 'p', attr: 'title', expr: expr('v', ['v']) }], sets: [] }, el, {}).update({ v: 'new' });
	assertEquals(el.querySelector('my-el p')!.getAttribute('title'), 'inner');
	assertEquals(el.querySelector('#own')!.getAttribute('title'), 'new');
});

Deno.test("PatchBranch: a print site skips the same element in a nested instance", () => {
	const inner = `<my-el><p data-bfid="p"><!--m0-->inner<!--m1--></p></my-el>`;
	const { el } = host(`${inner}<p id="own" data-bfid="p"><!--m0-->outer<!--m1--></p>`);
	const { errors } = captureErrors(() =>
		new PatchBranch({ sites: [{ bfid: 'p', markers: ['m0', 'm1'], expr: expr('v', ['v']) }], sets: [] }, el, {}).update({ v: 'new' }));
	assertEquals(errors, []);
	assertEquals(el.querySelector('my-el')!.outerHTML, inner);
	assertEquals(el.querySelector('#own')!.textContent, 'new');
});

Deno.test("PatchBranch: a set anchored on a descendant skips the same element in a nested instance", () => {
	const inner = `<my-el><section data-bfid="s">${SERVER_ELSE}</section></my-el>`;
	const { el } = host(`${inner}<section id="own" data-bfid="s">${SERVER_ELSE}</section>`);
	const pb = new PatchBranch({ sites: [], sets: [{ ...SET, bfid: 's' }] }, el, { mode: 'b', name: 'World' });
	pb.update({ mode: 'a', name: 'Mars' });
	assertEquals(el.querySelector('my-el')!.outerHTML, inner);
	assertEquals(el.querySelector('#own p')!.textContent, 'Hi Mars');
});

Deno.test("PatchBranch: a branch whose ref element holds a nested instance patches its own content", () => {
	const inner = `<my-el><p data-bfid="p">inner</p></my-el>`;
	const { el } = host(`<section data-bfid="s">${inner}${SERVER_A}</section>`);
	const pb = new PatchBranch({ sites: [], sets: [{ ...SET, bfid: 's' }] }, el, { mode: 'a', name: 'World' });
	const { errors } = captureErrors(() => pb.update({ mode: 'a', name: 'Mars' }));
	assertEquals(errors, []);
	assertEquals(el.querySelector('section my-el')!.outerHTML, inner);
	assertEquals(el.querySelector('section > p')!.textContent, 'Hi Mars');
});

Deno.test("PatchBranch: a site found only in a nested instance is reported, and writes nothing", () => {
	const { el } = host(`<my-el><p data-bfid="p" title="inner"></p></my-el>`);
	const pb = new PatchBranch({ sites: [{ bfid: 'p', attr: 'title', expr: expr('v', ['v']) }], sets: [] }, el, {});
	const { errors, result: records } = captureErrors(() => mutations(el, () => pb.update({ v: 'new' })));
	assertEquals(records, []);
	assertEquals(errors.length, 1);
});

Deno.test("PatchBranch: a site on a call to the partial's own tag patches that call, not the one inside it", () => {
	const { el } = host(`<my-el id="own" data-bfid="c" title="a"><my-el id="deep" data-bfid="c" title="b"></my-el></my-el>`);
	new PatchBranch({ sites: [{ bfid: 'c', attr: 'title', expr: expr('v', ['v']) }], sets: [] }, el, {}).update({ v: 'new' });
	assertEquals(el.querySelector('#own')!.getAttribute('title'), 'new');
	assertEquals(el.querySelector('#deep')!.getAttribute('title'), 'b');
});

// --- the same data-bfid twice within one instance -----------------------------

Deno.test("PatchBranch: an attr site on an element found twice is reported, and neither is patched", () => {
	const { el } = host(`<p data-bfid="p" title="x"></p><p data-bfid="p" title="x"></p>`);
	const pb = new PatchBranch({ sites: [{ bfid: 'p', attr: 'title', expr: expr('v', ['v']) }], sets: [] }, el, {});
	const { errors, result: records } = captureErrors(() => mutations(el, () => pb.update({ v: 'new' })));
	assertEquals(records, []);
	assertEquals(errors.length, 1);
	assertEquals(String(errors[0][0]).includes('[data-bfid="p"]'), true);
});

Deno.test("PatchBranch: a print site on an element found twice is reported, and neither is patched", () => {
	const { el } = host(`<p data-bfid="p"><!--m0-->x<!--m1--></p><p data-bfid="p"><!--m0-->x<!--m1--></p>`);
	const pb = new PatchBranch({ sites: [{ bfid: 'p', markers: ['m0', 'm1'], expr: expr('v', ['v']) }], sets: [] }, el, {});
	const { errors, result: records } = captureErrors(() => mutations(el, () => pb.update({ v: 'new' })));
	assertEquals(records, []);
	assertEquals(errors.length, 1);
});

Deno.test("PatchBranch: a set anchored on an element found twice is reported, and does not swap", () => {
	const { el } = host(`<section data-bfid="s">${SERVER_A}</section><section data-bfid="s">${SERVER_A}</section>`);
	const { errors, result: pb } = captureErrors(() =>
		new PatchBranch({ sites: [], sets: [{ ...SET, bfid: 's' }] }, el, { mode: 'a', name: 'World' }));
	assertEquals(errors.length > 0, true);
	assertEquals(String(errors[0][0]).includes('[data-bfid="s"]'), true);
	const swap = captureErrors(() => mutations(el, () => pb.update({ mode: 'b', name: 'World' })));
	assertEquals(swap.result, []);
	assertEquals(swap.errors.length > 0, true);
});

Deno.test("PatchBranch: a duplicate is reported on each update until it is gone, then patching resumes", () => {
	const { el } = host(`<p data-bfid="p" title="x"></p><p id="copy" data-bfid="p" title="x"></p>`);
	const pb = new PatchBranch({ sites: [{ bfid: 'p', attr: 'title', expr: expr('v', ['v']) }], sets: [] }, el, {});
	assertEquals(captureErrors(() => pb.update({ v: 'x' })).errors.length, 1);
	assertEquals(captureErrors(() => pb.update({ v: 'x' })).errors.length, 1);
	el.querySelector('#copy')!.remove();
	assertEquals(captureErrors(() => pb.update({ v: 'new' })).errors, []);
	assertEquals(el.querySelector('p')!.getAttribute('title'), 'new');
});

Deno.test("PatchBranch: the same data-bfid in a nested instance is not reported as a duplicate", () => {
	const { el } = host(`<my-el><p data-bfid="p"></p></my-el><p id="own" data-bfid="p"></p>`);
	const pb = new PatchBranch({ sites: [{ bfid: 'p', attr: 'title', expr: expr('v', ['v']) }], sets: [] }, el, {});
	const { errors } = captureErrors(() => pb.update({ v: 'new' }));
	assertEquals(errors, []);
	assertEquals(el.querySelector('#own')!.getAttribute('title'), 'new');
});

Deno.test("PatchBranch: a copy made after a site is patched goes unreported until its value changes", () => {
	const { el } = host(`<p id="own" data-bfid="p" title="x"></p>`);
	const pb = new PatchBranch({ sites: [{ bfid: 'p', attr: 'title', expr: expr('v', ['v']) }], sets: [] }, el, {});
	pb.update({ v: 'x' });
	const own = el.querySelector('#own')!;
	own.after(own.cloneNode(true));
	assertEquals(captureErrors(() => pb.update({ v: 'x' })).errors, []);
	assertEquals(captureErrors(() => pb.update({ v: 'new' })).errors.length, 1);
	assertEquals(own.getAttribute('title'), 'x');
});

// --- the same marker comments twice within one element -------------------------

// Every child of `el` cloned onto its end, as a script copying its content would.
function cloneChildren(el: Element): ChildNode[] {
	const copies = Array.from(el.childNodes).map(n => n.cloneNode(true) as ChildNode);
	el.append(...copies);
	return copies;
}

Deno.test("PatchBranch: a print whose markers appear twice is reported, and neither copy is patched", () => {
	const { el } = host(`<!--m0-->x<!--m1--><!--m0-->x<!--m1-->`);
	const pb = new PatchBranch({ sites: [{ bfid: null, markers: ['m0', 'm1'], expr: expr('v', ['v']) }], sets: [] }, el, {});
	const { errors, result: records } = captureErrors(() => mutations(el, () => pb.update({ v: 'new' })));
	assertEquals(records, []);
	assertEquals(errors.length, 1);
});

Deno.test("PatchBranch: a print reports its repeated markers on each update, and resumes once they are gone", () => {
	const { el } = host(`<!--m0-->x<!--m1-->`);
	const pb = new PatchBranch({ sites: [{ bfid: null, markers: ['m0', 'm1'], expr: expr('v', ['v']) }], sets: [] }, el, {});
	const copies = cloneChildren(el);
	assertEquals(captureErrors(() => pb.update({ v: 'a' })).errors.length, 1);
	assertEquals(captureErrors(() => pb.update({ v: 'a' })).errors.length, 1);
	for (const c of copies) c.remove();
	assertEquals(captureErrors(() => pb.update({ v: 'a' })).errors, []);
	assertEquals(el.innerHTML, `<!--m0-->a<!--m1-->`);
});

Deno.test("PatchBranch: a set whose markers appear twice at startup is reported, and does not swap", () => {
	const { el } = host(SERVER_A + SERVER_A);
	const { errors, result: pb } = captureErrors(() => new PatchBranch({ sites: [], sets: [SET] }, el, { mode: 'a', name: 'World' }));
	assertEquals(errors.length > 0, true);
	const swap = captureErrors(() => mutations(el, () => pb.update({ mode: 'b', name: 'World' })));
	assertEquals(swap.result, []);
	assertEquals(swap.errors.length > 0, true);
});

Deno.test("PatchBranch: a set skipped for repeated markers swaps once they are gone", () => {
	const { el } = host(SERVER_A);
	const pb = new PatchBranch({ sites: [], sets: [SET] }, el, { mode: 'a', name: 'World' });
	const copies = cloneChildren(el);
	const skipped = captureErrors(() => mutations(el, () => pb.update({ mode: 'b', name: 'World' })));
	assertEquals(skipped.result, []);
	assertEquals(skipped.errors.length > 0, true);
	for (const c of copies) c.remove();
	assertEquals(captureErrors(() => pb.update({ mode: 'b', name: 'World' })).errors, []);
	assertEquals(el.innerHTML, SERVER_ELSE);
});

Deno.test("PatchBranch: a set skipped for a missing marker swaps once it is back", () => {
	const { el } = host(SERVER_A);
	const pb = new PatchBranch({ sites: [], sets: [SET] }, el, { mode: 'a', name: 'World' });
	const start = el.firstChild as ChildNode;
	start.remove();
	assertEquals(captureErrors(() => pb.update({ mode: 'b', name: 'World' })).errors.length > 0, true);
	el.prepend(start);
	assertEquals(captureErrors(() => pb.update({ mode: 'b', name: 'World' })).errors, []);
	assertEquals(el.innerHTML, SERVER_ELSE);
});

// --- BackflipShell -----------------------------------------------------------

Deno.test("BackflipShell: reads each declared attr as a string or a boolean", () => {
	const { el } = host('');
	el.setAttribute('title', 'T');
	el.setAttribute('open', '');
	class Shell extends BackflipShell {
		static override bfAttrs = { title: 'string', missing: 'string', open: 'bool', closed: 'bool' } as const;
	}
	assertEquals(new Shell(el).collectData(), { title: 'T', missing: '', open: true, closed: false });
});

Deno.test("BackflipShell: puts each declared store next to the attributes", () => {
	const { el } = host('');
	el.setAttribute('id', '42');
	const widgets = { data: { '42': 'Gizmo' } };
	class Shell extends BackflipShell {
		static override bfAttrs = { id: 'string' } as const;
		static override bfStores = { widgets };
	}
	const data = new Shell(el).collectData();
	assertEquals(data, { widgets, id: '42' });
	assertEquals(data.widgets === widgets, true);
});

const PRINT_NAME: BranchDesc = { sites: [{ bfid: 'p', markers: ['m0', 'm1'], expr: expr('name', ['name']) }], sets: [] };

Deno.test("BackflipShell: constructing patches from the current attributes", () => {
	const { el } = host(`<p data-bfid="p"><!--m0-->x<!--m1--></p>`);
	el.setAttribute('name', 'World');
	class Shell extends BackflipShell {
		static override bfAttrs = { name: 'string' } as const;
		static override bfRoot = PRINT_NAME;
	}
	new Shell(el);
	assertEquals(el.querySelector('p')!.textContent, 'World');
});

Deno.test("BackflipShell: update takes effect on the flush, reading the current attributes", () => {
	const { el } = host(`<p data-bfid="p"><!--m0-->x<!--m1--></p>`);
	el.setAttribute('name', 'x');
	class Shell extends BackflipShell {
		static override bfAttrs = { name: 'string' } as const;
		static override bfRoot = PRINT_NAME;
	}
	const shell = new Shell(el);
	el.setAttribute('name', 'Mars');
	shell.update();
	assertEquals(el.querySelector('p')!.textContent, 'x');
	flush();
	assertEquals(el.querySelector('p')!.textContent, 'Mars');
});

// A root branch printing `name`, logging each value its expression sees.
function loggingPrint(log: unknown[], code: string, vars: string[]): BranchDesc {
	const fn = new Function(...vars, `return ${code};`) as (...args: unknown[]) => unknown;
	return { sites: [{ bfid: 'p', markers: ['m0', 'm1'], expr: {
		fn: (...args: unknown[]) => { const v = fn(...args); log.push(v); return v; }, vars,
	} }], sets: [] };
}

Deno.test("BackflipShell: a sync with nothing changed evaluates nothing", () => {
	const { el } = host(`<p data-bfid="p"><!--m0-->x<!--m1--></p>`);
	el.setAttribute('name', 'x');
	const log: unknown[] = [];
	class Shell extends BackflipShell {
		static override bfAttrs = { name: 'string' } as const;
		static override bfRoot = loggingPrint(log, 'name', ['name']);
	}
	const shell = new Shell(el);
	log.length = 0;
	shell.update();
	flush();
	assertEquals(log, []);
});

Deno.test("BackflipShell: several attributes changed before the flush sync once", () => {
	const { el } = host(`<p data-bfid="p"><!--m0-->x<!--m1--></p>`);
	const log: unknown[] = [];
	class Shell extends BackflipShell {
		static override bfAttrs = { a: 'string', b: 'string' } as const;
		static override bfRoot = loggingPrint(log, 'a + b', ['a', 'b']);
	}
	const shell = new Shell(el);
	log.length = 0;
	el.setAttribute('a', '1');
	shell.update();
	el.setAttribute('b', '2');
	shell.update();
	flush();
	assertEquals(log, ['12']);
});

// A parent shell passing `store.data.label` to a child's `label` attribute, the child
// printing its attribute and the store's `suffix`, and both reading the store. The
// child's expression logs what it sees.
function parentAndChild() {
	const dom = new JSDOM(`<!DOCTYPE html><body><x-parent><x-child data-bfid="c" label="A"><p data-bfid="p"><!--m0-->A!<!--m1--></p></x-child></x-parent></body>`);
	const doc = dom.window.document;
	const parent = doc.querySelector('x-parent')!, child = doc.querySelector('x-child')!;
	const store = { data: { label: 'A', suffix: '!' } };
	const log: unknown[] = [];
	class ChildShell extends BackflipShell {
		static override bfAttrs = { label: 'string' } as const;
		static override bfStores = { store };
		static override bfRoot = loggingPrint(log, 'label + store.data.suffix', ['label', 'store']);
	}
	class ParentShell extends BackflipShell {
		static override bfStores = { store };
		static override bfRoot: BranchDesc = { sites: [{ bfid: 'c', attr: 'label', expr: expr('store.data.label', ['store']) }], sets: [] };
	}
	// The child registers first, so it is first in the list.
	const childShell = new ChildShell(child);
	const parentShell = new ParentShell(parent);
	log.length = 0;
	return { dom, parent, child, store, log, childShell, parentShell };
}

Deno.test("Reactivity: a parent patches before a child that is first in the list", () => {
	const { store, child, log } = parentAndChild();
	store.data = { label: 'B', suffix: '?' };
	storeChanged(store);
	flush();
	// One evaluation, seeing both the parent's attribute and the store's new data.
	assertEquals(log, ['B?']);
	assertEquals(child.querySelector('p')!.textContent, 'B?');
});

Deno.test("Reactivity: a child removed by an ancestor during the dispatch does not sync", () => {
	const { parent, child, store, log, childShell } = parentAndChild();
	// What an ancestor's patch would do: remove the child once the event is on its way.
	const remove = () => child.remove();
	parent.addEventListener('bf-store-flush', remove, { capture: true });
	store.data = { label: 'A', suffix: '?' };
	enqueue(child);
	flush();
	parent.removeEventListener('bf-store-flush', remove, { capture: true });
	assertEquals(log, []);
	assertEquals(child.querySelector('p')!.textContent, 'A!');

	// Connected again, it catches up on what it missed.
	parent.append(child);
	childShell.update();
	flush();
	assertEquals(child.querySelector('p')!.textContent, 'A?');
});

Deno.test("Reactivity: an element changed while disconnected catches up on reconnect", () => {
	const { parent, child, store, childShell } = parentAndChild();
	child.remove();
	store.data = { label: 'A', suffix: '?' };
	storeChanged(store);
	flush();
	assertEquals(child.querySelector('p')!.textContent, 'A!');
	parent.append(child);
	childShell.update();
	flush();
	assertEquals(child.querySelector('p')!.textContent, 'A?');
});

Deno.test("Reactivity: a shell whose sync throws does not stop the others", () => {
	const { el } = host(`<p data-bfid="p"><!--m0-->x<!--m1--></p><i></i>`);
	const other = el.querySelector('i')!;
	class Bad extends BackflipShell {
		override sync(): void { throw new Error('boom'); }
	}
	new Bad(other);
	el.setAttribute('name', 'x');
	class Shell extends BackflipShell {
		static override bfAttrs = { name: 'string' } as const;
		static override bfRoot = PRINT_NAME;
	}
	const shell = new Shell(el);
	el.setAttribute('name', 'Mars');
	captureErrors(() => {
		enqueue(other);
		shell.update();
		flush();
	});
	assertEquals(el.querySelector('p')!.textContent, 'Mars');
});

// --- BackflipElement: what holds without a DOM ------------------------------

Deno.test("BackflipElement: the module loads with no DOM, and the base observes nothing", () => {
	assertEquals(typeof BackflipElement, 'function');
	assertEquals(BackflipElement.observedAttributes, []);
});

Deno.test("BackflipElement: observedAttributes is its shell's declared attributes", () => {
	class Shell extends BackflipShell {
		static override bfAttrs = { title: 'string', open: 'bool' } as const;
	}
	class Generated extends BackflipElement {
		static override bfShell = Shell;
	}
	assertEquals(Generated.observedAttributes, ['title', 'open']);
	assertEquals(BackflipElement.observedAttributes, []);
});

Deno.test("BackflipElement: an author subclass can spread super.observedAttributes", () => {
	class Shell extends BackflipShell {
		static override bfAttrs = { title: 'string' } as const;
	}
	class Generated extends BackflipElement {
		static override bfShell = Shell;
	}
	class Authored extends Generated {
		static override get observedAttributes() { return [...super.observedAttributes, 'extra']; }
	}
	assertEquals(Authored.observedAttributes, ['title', 'extra']);
});

// --- PatchBranch: limited to a b-for item's nodes ----------------------------
//
// Items share a parent and repeat each other's data-bfids and markers, so a branch
// given an item range sees only that item.

function loop(...items: string[]): string {
	return `<!--ls-->${items.map(i => `<!--it-->${i}`).join('')}<!--le-->`;
}

function itemRange(el: Element, n: number, itemMarker = 'it', endMarker = 'le'): ItemRange {
	const opening = [...el.childNodes].filter(c => c.nodeType === 8 && c.nodeValue === itemMarker);
	return { start: opening[n], itemMarker, endMarker };
}

// A branch for item `n` of the loop in `el`, as the runtime builds one.
function itemBranch(desc: BranchDesc, el: Element, n: number, data: Record<string, unknown> = {}): PatchBranch {
	return new PatchBranch(desc, el, data, el, itemRange(el, n));
}

const TITLE_SITE: BranchDesc = { sites: [{ bfid: 'x', attr: 'title', expr: expr('v', ['v']) }], sets: [] };
const TITLES = (el: Element) => [...el.querySelectorAll('[data-bfid="x"]')].map(e => e.getAttribute('title'));

Deno.test("item range: an attr site patches only its own item's copy", () => {
	const { el } = host(loop(`<li data-bfid="x" title="a"></li>`, `<li data-bfid="x" title="b"></li>`));
	const { errors } = captureErrors(() => itemBranch(TITLE_SITE, el, 1).update({ v: 'new' }));
	assertEquals(errors, []);
	assertEquals(TITLES(el), ['a', 'new']);
});

Deno.test("item range: finds an anchor nested inside an item's root", () => {
	const { el } = host(loop(`<li><b data-bfid="x" title="a"></b></li>`, `<li><b data-bfid="x" title="b"></b></li>`));
	const { errors } = captureErrors(() => itemBranch(TITLE_SITE, el, 0).update({ v: 'new' }));
	assertEquals(errors, []);
	assertEquals(TITLES(el), ['new', 'b']);
});

Deno.test("item range: a print inside an element patches only its own item's copy", () => {
	const { el } = host(loop(`<li data-bfid="p"><!--m0-->a<!--m1--></li>`, `<li data-bfid="p"><!--m0-->b<!--m1--></li>`));
	const desc: BranchDesc = { sites: [{ bfid: 'p', markers: ['m0', 'm1'], expr: expr('v', ['v']) }], sets: [] };
	const { errors } = captureErrors(() => itemBranch(desc, el, 1).update({ v: 'new' }));
	assertEquals(errors, []);
	assertEquals([...el.querySelectorAll('li')].map(li => li.textContent), ['a', 'new']);
});

Deno.test("item range: a print directly in the item uses its own repeated markers", () => {
	const { el } = host(loop(`<!--m0-->a<!--m1-->`, `<!--m0-->b<!--m1-->`));
	const desc: BranchDesc = { sites: [{ bfid: null, markers: ['m0', 'm1'], expr: expr('v', ['v']) }], sets: [] };
	const { errors } = captureErrors(() => itemBranch(desc, el, 0).update({ v: 'new' }));
	assertEquals(errors, []);
	assertEquals(el.innerHTML, loop(`<!--m0-->new<!--m1-->`, `<!--m0-->b<!--m1-->`));
});

Deno.test("item range: an anchor found only in a sibling item is reported, and the sibling is left alone", () => {
	const { el } = host(loop(`<li data-bfid="x" title="a"></li>`, `<li></li>`));
	const { errors } = captureErrors(() => itemBranch(TITLE_SITE, el, 1).update({ v: 'new' }));
	assertEquals(errors.length, 1);
	assertEquals(TITLES(el), ['a']);
});

Deno.test("item range: an anchor repeated within the item is reported, and neither copy is patched", () => {
	const { el } = host(loop(`<li data-bfid="x" title="a"></li><li data-bfid="x" title="b"></li>`));
	const { errors } = captureErrors(() => itemBranch(TITLE_SITE, el, 0).update({ v: 'new' }));
	assertEquals(errors.length, 1);
	assertEquals(TITLES(el), ['a', 'b']);
});

Deno.test("item range: a marker repeated within the item is reported", () => {
	const { el } = host(loop(`<!--m0-->a<!--m1--><!--m0-->b<!--m1-->`));
	const desc: BranchDesc = { sites: [{ bfid: null, markers: ['m0', 'm1'], expr: expr('v', ['v']) }], sets: [] };
	const { errors } = captureErrors(() => itemBranch(desc, el, 0).update({ v: 'new' }));
	assertEquals(errors.length, 1);
});

Deno.test("item range: stops at the loop's end marker and ignores what surrounds the loop", () => {
	const { el } = host(`<li data-bfid="x" title="before"></li>${loop(`<li data-bfid="x" title="a"></li>`)}<li data-bfid="x" title="after"></li>`);
	const { errors } = captureErrors(() => itemBranch(TITLE_SITE, el, 0).update({ v: 'new' }));
	assertEquals(errors, []);
	assertEquals(TITLES(el), ['before', 'new', 'after']);
});

Deno.test("item range: an empty item has nothing to find", () => {
	const { el } = host(loop(``, `<li data-bfid="x" title="b"></li>`));
	const { errors } = captureErrors(() => itemBranch(TITLE_SITE, el, 0).update({ v: 'new' }));
	assertEquals(errors.length, 1);
	assertEquals(TITLES(el), ['b']);
});

Deno.test("item range: an anchor inside a nested instance of the same tag is not this branch's", () => {
	const { el } = host(loop(`<my-el><li data-bfid="x" title="nested"></li></my-el><li data-bfid="x" title="own"></li>`));
	const { errors } = captureErrors(() => itemBranch(TITLE_SITE, el, 0).update({ v: 'new' }));
	assertEquals(errors, []);
	assertEquals(TITLES(el), ['nested', 'new']);
});

Deno.test("item range: a branch keeps patching its own item after the item's nodes move", () => {
	const { el } = host(loop(`<li data-bfid="x" title="a"></li>`, `<li data-bfid="x" title="b"></li>`));
	const pb = itemBranch(TITLE_SITE, el, 1);
	const [first] = [...el.childNodes].filter(c => c.nodeValue === 'it');
	const second = pb.range!.start;
	first.before(second, second.nextSibling!);
	const { errors } = captureErrors(() => pb.update({ v: 'new' }));
	assertEquals(errors, []);
	assertEquals(TITLES(el), ['new', 'a']);
});

// Sets directly in an item, on the parent element: their markers repeat across items.

const SET_ITEM_A = (name: string) => `<!--s0--><!--b0--><p data-bfid="p">Hi <!--n0-->${name}<!--n1--></p><!--s1-->`;

Deno.test("item range: a set reads the branch rendered in its own item", () => {
	const { el } = host(loop(SERVER_ELSE, SERVER_A));
	const desc: BranchDesc = { sites: [], sets: [SET] };
	assertEquals(itemBranch(desc, el, 0).sets[0].active, 1);
	assertEquals(itemBranch(desc, el, 1).sets[0].active, 0);
});

Deno.test("item range: a set swaps its branch in its own item only", () => {
	const { el } = host(loop(SET_ITEM_A('one'), SET_ITEM_A('two')));
	const pb = itemBranch({ sites: [], sets: [SET] }, el, 0, { mode: 'a', name: 'one' });
	const { errors } = captureErrors(() => pb.update({ mode: 'b', name: 'one' }));
	assertEquals(errors, []);
	assertEquals(el.innerHTML, loop(SERVER_ELSE, SET_ITEM_A('two')));
});

Deno.test("item range: a set's live branch patches within the item", () => {
	const { el } = host(loop(SET_ITEM_A('one'), SET_ITEM_A('two')));
	const pb = itemBranch({ sites: [], sets: [SET] }, el, 1, { mode: 'a', name: 'two' });
	const { errors } = captureErrors(() => pb.update({ mode: 'a', name: 'new' }));
	assertEquals(errors, []);
	assertEquals(el.innerHTML, loop(SET_ITEM_A('one'), SET_ITEM_A('new')));
});

Deno.test("item range: a branch swapped in by a set patches within the item", () => {
	const { el } = host(loop(SET_ITEM_A('one'), SERVER_ELSE));
	const pb = itemBranch({ sites: [], sets: [SET] }, el, 1, { mode: 'b', name: 'x' });
	const { errors } = captureErrors(() => {
		pb.update({ mode: 'a', name: 'two' });
		pb.update({ mode: 'a', name: 'new' });
	});
	assertEquals(errors, []);
	assertEquals(el.innerHTML, loop(SET_ITEM_A('one'), SET_ITEM_A('new')));
});

Deno.test("item range: a set nested in a set's branch stays within the item", () => {
	const inner: IfRNode = { type: 'if', branches: [
		{ condition: expr('on', ['on']), nodes: [{ type: 'comment', text: 'ib0' }, { type: 'raw', raw: '<u>on</u>' }] },
		{ nodes: [{ type: 'comment', text: 'ib1' }, { type: 'raw', raw: '<u>off</u>' }] },
	] };
	const innerSet: SetDesc = { bfid: null, markers: ['i0', 'i1'], snapshot: inner, branches: [null, null], branchMarkers: ['ib0', 'ib1'] };
	const outer: IfRNode = { type: 'if', branches: [{ condition: expr('show', ['show']), nodes: [] }] };
	const outerSet: SetDesc = { bfid: null, markers: ['s0', 's1'], snapshot: outer, branches: [{ sites: [], sets: [innerSet] }], branchMarkers: ['b0'] };
	const item = (word: string, marker: string) => `<!--s0--><!--b0--><!--i0--><!--${marker}--><u>${word}</u><!--i1--><!--s1-->`;
	const { el } = host(loop(item('on', 'ib0'), item('on', 'ib0')));
	const pb = itemBranch({ sites: [], sets: [outerSet] }, el, 1, { show: true, on: true });
	const { errors } = captureErrors(() => pb.update({ show: true, on: false }));
	assertEquals(errors, []);
	assertEquals(el.innerHTML, loop(item('on', 'ib0'), item('off', 'ib1')));
});

Deno.test("item range: a set anchored to an element in the item patches against that element", () => {
	const anchored: SetDesc = { ...SET, bfid: 'w' };
	const item = (body: string) => `<div data-bfid="w">${body}</div>`;
	const { el } = host(loop(item(SET_ITEM_A('one')), item(SET_ITEM_A('two'))));
	const pb = itemBranch({ sites: [], sets: [anchored] }, el, 1, { mode: 'a', name: 'two' });
	assertEquals(pb.sets[0].children.get(0)!.refElem, el.querySelectorAll('div')[1]);
	assertEquals(pb.sets[0].children.get(0)!.range, undefined);
	const { errors } = captureErrors(() => pb.update({ mode: 'a', name: 'new' }));
	assertEquals(errors, []);
	assertEquals(el.innerHTML, loop(item(SET_ITEM_A('one')), item(SET_ITEM_A('new'))));
});

// A loop directly in another loop's item: both sets of markers sit under one parent.

const NESTED_LOOPS = `<!--ls--><!--it-->`
	+ `<!--ils--><!--iit--><b data-bfid="x" title="1"></b><!--iit--><b data-bfid="x" title="2"></b><!--ile-->`
	+ `<i data-bfid="o" title="outer"></i>`
	+ `<!--it--><i data-bfid="o" title="other"></i><!--le-->`;

Deno.test("item range: an outer item runs past an inner loop's markers", () => {
	const { el } = host(NESTED_LOOPS);
	const desc: BranchDesc = { sites: [{ bfid: 'o', attr: 'title', expr: expr('v', ['v']) }], sets: [] };
	const { errors } = captureErrors(() => itemBranch(desc, el, 0).update({ v: 'new' }));
	assertEquals(errors, []);
	assertEquals([...el.querySelectorAll('i')].map(i => i.title), ['new', 'other']);
});

Deno.test("item range: an inner item is limited to itself", () => {
	const { el } = host(NESTED_LOOPS);
	const range = itemRange(el, 1, 'iit', 'ile');
	const { errors } = captureErrors(() => new PatchBranch(TITLE_SITE, el, {}, el, range).update({ v: 'new' }));
	assertEquals(errors, []);
	assertEquals(TITLES(el), ['1', 'new']);
});

Deno.test("item range: an inner item does not reach past its loop's end marker", () => {
	const { el } = host(NESTED_LOOPS);
	const desc: BranchDesc = { sites: [{ bfid: 'o', attr: 'title', expr: expr('v', ['v']) }], sets: [] };
	const range = itemRange(el, 1, 'iit', 'ile');
	const { errors } = captureErrors(() => new PatchBranch(desc, el, {}, el, range).update({ v: 'new' }));
	assertEquals(errors.length, 1);
	assertEquals([...el.querySelectorAll('i')].map(i => i.title), ['outer', 'other']);
});

// --- PatchBranch: b-for loops, pairing and updating ---------------------------

const LOOP: LoopDesc = {
	bfid: null, markers: ['ls', 'le'], itemMarker: 'it', key: expr('x.id', ['x']),
	snapshot: { type: 'for', iterable: expr('xs', ['xs']), valName: 'x', nodes: [
		{ type: 'comment', text: 'it' },
		{ type: 'raw', raw: '<li data-bfid="x" title="' },
		{ type: 'print', data: expr('x.name', ['x']) },
		{ type: 'raw', raw: '"></li>' },
	] },
	item: { sites: [{ bfid: 'x', attr: 'title', expr: expr('x.name', ['x']) }], sets: [] },
};
const FOR = (over: Partial<ForRNode>): ForRNode => ({ ...LOOP.snapshot, ...over });
const LOOP_ROOT: BranchDesc = { sites: [], sets: [], loops: [LOOP] };
const li = (name: string) => `<li data-bfid="x" title="${name}"></li>`;
const AB = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];

Deno.test("loop: at init the Nth key is paired with the Nth item marker", () => {
	const { el } = host(loop(li('A'), li('B')));
	const pb = new PatchBranch(LOOP_ROOT, el, { xs: AB });
	const markers = [...el.childNodes].filter(c => c.nodeValue === 'it');
	const items = pb.loops[0].items!;
	assertEquals([...items.keys()], [1, 2]);
	assertEquals(items.get(1)!.range!.start, markers[0]);
	assertEquals(items.get(2)!.range!.start, markers[1]);
});

Deno.test("loop: pairing comes from the data, so it writes nothing to the DOM", () => {
	const { el } = host(loop(li('A'), li('B')));
	const records = mutations(el, () => {
		const pb = new PatchBranch(LOOP_ROOT, el, { xs: AB });
		pb.update({ xs: AB });
	});
	assertEquals(records, []);
});

Deno.test("loop: an empty list pairs with no items", () => {
	const { el } = host(loop());
	const { result: pb, errors } = captureErrors(() => new PatchBranch(LOOP_ROOT, el, { xs: [] }));
	assertEquals(errors, []);
	assertEquals(pb.loops[0].items!.size, 0);
});

Deno.test("loop: a changed item is updated in place, and the other items are not touched", () => {
	const { el } = host(loop(li('A'), li('B')));
	const pb = new PatchBranch(LOOP_ROOT, el, { xs: AB });
	const [first, second] = el.querySelectorAll('li');
	const records = mutations(el, () => pb.update({ xs: [{ id: 1, name: 'A' }, { id: 2, name: 'New' }] }));
	assertEquals(records.length, 1);
	assertEquals(records[0].target, second);
	assertEquals([first.title, second.title], ['A', 'New']);
	assertEquals([...el.querySelectorAll('li')], [first, second]);
});

Deno.test("loop: an item's sites read the enclosing data too", () => {
	const desc: LoopDesc = { ...LOOP, item: { sites: [{ bfid: 'x', attr: 'title', expr: expr('x.name + suffix', ['x', 'suffix']) }], sets: [] } };
	const { el } = host(loop(li('A!'), li('B!')));
	const pb = new PatchBranch({ sites: [], sets: [], loops: [desc] }, el, { xs: AB, suffix: '!' });
	pb.update({ xs: AB, suffix: '?' });
	assertEquals(TITLES(el), ['A?', 'B?']);
});

Deno.test("loop: a loop name shadows the same name in the enclosing data", () => {
	const { el } = host(loop(li('A')));
	const pb = new PatchBranch(LOOP_ROOT, el, { xs: [AB[0]], x: { id: 9, name: 'outer' } });
	pb.update({ xs: [{ id: 1, name: 'New' }], x: { id: 9, name: 'outer' } });
	assertEquals(TITLES(el), ['New']);
});

Deno.test("loop: the index name is bound to the item's position", () => {
	const desc: LoopDesc = { ...LOOP, snapshot: FOR({ indexName: 'i' }), item: { sites: [{ bfid: 'x', attr: 'title', expr: expr('i', ['i']) }], sets: [] } };
	const { el } = host(loop(li('0'), li('1')));
	const pb = new PatchBranch({ sites: [], sets: [], loops: [desc] }, el, { xs: AB });
	const { errors } = captureErrors(() => pb.update({ xs: AB }));
	assertEquals(errors, []);
	assertEquals(TITLES(el), ['0', '1']);
});

Deno.test("loop: a key can be the index", () => {
	const desc: LoopDesc = { ...LOOP, snapshot: FOR({ indexName: 'i' }), key: expr('i', ['i']) };
	const { el } = host(loop(li('A'), li('A')));
	const pb = new PatchBranch({ sites: [], sets: [], loops: [desc] }, el, { xs: [{ name: 'A' }, { name: 'A' }] });
	assertEquals([...pb.loops[0].items!.keys()], [0, 1]);
	pb.update({ xs: [{ name: 'A' }, { name: 'B' }] });
	assertEquals(TITLES(el), ['A', 'B']);
});

Deno.test("loop: with no value name the item is not bound", () => {
	const desc: LoopDesc = { ...LOOP, snapshot: FOR({ valName: undefined, indexName: 'i' }), key: expr('i', ['i']),
		item: { sites: [{ bfid: 'x', attr: 'title', expr: expr('typeof x', ['x']) }], sets: [] } };
	const { el } = host(loop(li('undefined')));
	const pb = new PatchBranch({ sites: [], sets: [], loops: [desc] }, el, { xs: [1] });
	assertEquals(mutations(el, () => pb.update({ xs: [1] })), []);
});

Deno.test("loop: keys may be strings or numbers, which stay distinct", () => {
	const { el } = host(loop(li('A'), li('B')));
	const pb = new PatchBranch(LOOP_ROOT, el, { xs: [{ id: 1, name: 'A' }, { id: '1', name: 'B' }] });
	const { errors } = captureErrors(() => pb.update({ xs: [{ id: 1, name: 'A' }, { id: '1', name: 'New' }] }));
	assertEquals(errors, []);
	assertEquals(TITLES(el), ['A', 'New']);
});

Deno.test("loop: anchored to an element, it stays inside that element", () => {
	const desc: LoopDesc = { ...LOOP, bfid: 'u' };
	const { el } = host(`<ul data-bfid="u">${loop(li('A'), li('B'))}</ul>`);
	const pb = new PatchBranch({ sites: [], sets: [], loops: [desc] }, el, { xs: AB });
	pb.update({ xs: [AB[0], { id: 2, name: 'New' }] });
	assertEquals(TITLES(el), ['A', 'New']);
});

Deno.test("loop: other comments among the items are not item markers", () => {
	const { el } = host(loop(`<!--author-->${li('A')}`, li('B')));
	const { result: pb, errors } = captureErrors(() => new PatchBranch(LOOP_ROOT, el, { xs: AB }));
	assertEquals(errors, []);
	assertEquals(pb.loops[0].items!.size, 2);
});

Deno.test("loop: sibling content around the loop is left alone", () => {
	const { el } = host(`<li data-bfid="x" title="before"></li>${loop(li('A'))}<li data-bfid="x" title="after"></li>`);
	const pb = new PatchBranch(LOOP_ROOT, el, { xs: [AB[0]] });
	const { errors } = captureErrors(() => pb.update({ xs: [{ id: 1, name: 'New' }] }));
	assertEquals(errors, []);
	assertEquals(TITLES(el), ['before', 'New', 'after']);
});

// A set in each item, on the parent, whose condition reads the item.

const ITEM_SET: SetDesc = {
	bfid: null, markers: ['s0', 's1'], branchMarkers: ['b0', 'b1'], branches: [null, null],
	snapshot: { type: 'if', branches: [
		{ condition: expr('x.on', ['x']), nodes: [{ type: 'comment', text: 'b0' }, { type: 'raw', raw: '<u>on</u>' }] },
		{ nodes: [{ type: 'comment', text: 'b1' }, { type: 'raw', raw: '<u>off</u>' }] },
	] },
};
const on = `<!--s0--><!--b0--><u>on</u><!--s1-->`;
const off = `<!--s0--><!--b1--><u>off</u><!--s1-->`;

Deno.test("loop: a b-if in an item reads the item, and swaps within it", () => {
	const desc: LoopDesc = { ...LOOP, item: { sites: [], sets: [ITEM_SET] } };
	const { el } = host(loop(on, off));
	const pb = new PatchBranch({ sites: [], sets: [], loops: [desc] }, el, { xs: [{ id: 1, on: true }, { id: 2, on: false }] });
	const { errors } = captureErrors(() => pb.update({ xs: [{ id: 1, on: false }, { id: 2, on: false }] }));
	assertEquals(errors, []);
	assertEquals(el.innerHTML, loop(off, off));
});

Deno.test("loop: inside a set's branch, it is built with that branch and sees its range", () => {
	const set: SetDesc = {
		bfid: null, markers: ['s0', 's1'], branchMarkers: ['b0'],
		snapshot: { type: 'if', branches: [{ condition: expr('show', ['show']), nodes: [] }] },
		branches: [{ sites: [], sets: [], loops: [LOOP] }],
	};
	const { el } = host(`<!--s0--><!--b0-->${loop(li('A'), li('B'))}<!--s1-->`);
	const pb = new PatchBranch({ sites: [], sets: [set] }, el, { show: true, xs: AB });
	const { errors } = captureErrors(() => pb.update({ show: true, xs: [AB[0], { id: 2, name: 'New' }] }));
	assertEquals(errors, []);
	assertEquals(TITLES(el), ['A', 'New']);
});

// Loops nested in loops.

const INNER_LOOP = (bfid: string | null): LoopDesc => ({
	bfid, markers: ['ils', 'ile'], itemMarker: 'iit',
	key: expr('c.id', ['c']),
	snapshot: { type: 'for', iterable: expr('r.cells', ['r']), valName: 'c', nodes: [
		{ type: 'comment', text: 'iit' },
		{ type: 'raw', raw: '<li data-bfid="x" title="' },
		{ type: 'print', data: expr('c.name + r.tag', ['c', 'r']) },
		{ type: 'raw', raw: '"></li>' },
	] },
	item: { sites: [{ bfid: 'x', attr: 'title', expr: expr('c.name + r.tag', ['c', 'r']) }], sets: [] },
});
const ROWS = (tag: string) => [
	{ id: 'r1', tag, cells: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] },
	{ id: 'r2', tag, cells: [{ id: 1, name: 'c' }] },
];
const OUTER_LOOP = (inner: LoopDesc): BranchDesc => ({ sites: [], sets: [], loops: [{
	...LOOP, key: expr('r.id', ['r']),
	snapshot: { type: 'for', iterable: expr('rows', ['rows']), valName: 'r', nodes: [
		{ type: 'comment', text: 'it' },
		...(inner.bfid ? [{ type: 'raw', raw: `<ul data-bfid="${inner.bfid}">` } as const] : []),
		{ type: 'comment', text: 'ils' },
		inner.snapshot,
		{ type: 'comment', text: 'ile' },
		...(inner.bfid ? [{ type: 'raw', raw: '</ul>' } as const] : []),
	] },
	item: { sites: [], sets: [], loops: [inner] },
}] });
const innerLoop = (...items: string[]) => `<!--ils-->${items.map(i => `<!--iit-->${i}`).join('')}<!--ile-->`;

Deno.test("loop: nested directly under the same parent, each inner loop stays in its outer item", () => {
	const html = loop(innerLoop(li('a'), li('b')), innerLoop(li('c')));
	const { el } = host(html);
	const pb = new PatchBranch(OUTER_LOOP(INNER_LOOP(null)), el, { rows: ROWS('') });
	const { errors } = captureErrors(() => pb.update({ rows: ROWS('!') }));
	assertEquals(errors, []);
	assertEquals(TITLES(el), ['a!', 'b!', 'c!']);
});

Deno.test("loop: nested in an element of each outer item, each inner loop finds its own element", () => {
	const row = (...items: string[]) => `<ul data-bfid="u">${innerLoop(...items)}</ul>`;
	const { el } = host(loop(row(li('a'), li('b')), row(li('c'))));
	const pb = new PatchBranch(OUTER_LOOP(INNER_LOOP('u')), el, { rows: ROWS('') });
	const { errors } = captureErrors(() => pb.update({ rows: ROWS('!') }));
	assertEquals(errors, []);
	assertEquals(TITLES(el), ['a!', 'b!', 'c!']);
});

// What cannot be paired: reported, and the loop is left as rendered.

for (const [label, xs] of [
	['an object', { a: AB[0] }],
	['a string', 'ab'],
	['null', null],
	['undefined', undefined],
] as const) {
	Deno.test(`loop: over ${label} at init is reported, and the loop stays as rendered`, () => {
		const { el } = host(loop(li('A')));
		const { result: pb, errors } = captureErrors(() => new PatchBranch(LOOP_ROOT, el, { xs }));
		assertEquals(errors.length, 1);
		assertEquals(pb.loops[0].items, null);
		const later = captureErrors(() => pb.update({ xs: [{ id: 1, name: 'New' }] }));
		assertEquals(later.errors, []);
		assertEquals(TITLES(el), ['A']);
	});
}

for (const [label, html, xs] of [
	['more items than markers', loop(li('A')), AB],
	['more markers than items', loop(li('A'), li('B')), [AB[0]]],
	['items and no markers', loop(), AB],
] as const) {
	Deno.test(`loop: ${label} at init is reported, and the loop stays as rendered`, () => {
		const { el } = host(html);
		const { result: pb, errors } = captureErrors(() => new PatchBranch(LOOP_ROOT, el, { xs }));
		assertEquals(errors.length, 1);
		assertEquals(pb.loops[0].items, null);
		const before = el.innerHTML;
		captureErrors(() => pb.update({ xs: [{ id: 1, name: 'New' }] }));
		assertEquals(el.innerHTML, before);
	});
}

const BAD_KEYS: [string, unknown[]][] = [
	['a duplicate key', [{ id: 1, name: 'A' }, { id: 1, name: 'B' }]],
	['a null key', [{ id: 1, name: 'A' }, { id: null, name: 'B' }]],
	['a missing key', [{ id: 1, name: 'A' }, { name: 'B' }]],
	['a boolean key', [{ id: 1, name: 'A' }, { id: true, name: 'B' }]],
	['an object key', [{ id: 1, name: 'A' }, { id: {}, name: 'B' }]],
	['a non-finite key', [{ id: 1, name: 'A' }, { id: NaN, name: 'B' }]],
	['a key that throws', [{ id: 1, name: 'A' }, null]],
];

for (const [label, xs] of BAD_KEYS) {
	Deno.test(`loop: ${label} at init is reported, and the loop stays as rendered`, () => {
		const { el } = host(loop(li('A'), li('B')));
		const { result: pb, errors } = captureErrors(() => new PatchBranch(LOOP_ROOT, el, { xs }));
		assertEquals(errors.length, 1);
		assertEquals(pb.loops[0].items, null);
	});

	Deno.test(`loop: ${label} on update is reported, nothing is patched, and the next update recovers`, () => {
		const { el } = host(loop(li('A'), li('B')));
		const pb = new PatchBranch(LOOP_ROOT, el, { xs: AB });
		const { errors } = captureErrors(() => pb.update({ xs }));
		assertEquals(errors.length, 1);
		assertEquals(TITLES(el), ['A', 'B']);
		pb.update({ xs: [{ id: 1, name: 'New' }, AB[1]] });
		assertEquals(TITLES(el), ['New', 'B']);
	});
}

for (const [label, xs] of [['an object', { a: 1 }], ['null', null]] as const) {
	Deno.test(`loop: over ${label} on update is reported, nothing is patched, and the next update recovers`, () => {
		const { el } = host(loop(li('A'), li('B')));
		const pb = new PatchBranch(LOOP_ROOT, el, { xs: AB });
		const { errors } = captureErrors(() => pb.update({ xs }));
		assertEquals(errors.length, 1);
		assertEquals(TITLES(el), ['A', 'B']);
		pb.update({ xs: [{ id: 1, name: 'New' }, AB[1]] });
		assertEquals(TITLES(el), ['New', 'B']);
	});
}

Deno.test("loop: an iterable that throws at init is reported, and the loop stays as rendered", () => {
	const desc: LoopDesc = { ...LOOP, snapshot: FOR({ iterable: expr('o.xs', ['o']) }) };
	const { el } = host(loop(li('A')));
	const { result: pb, errors } = captureErrors(() => new PatchBranch({ sites: [], sets: [], loops: [desc] }, el, {}));
	assertEquals(errors.length, 1);
	assertEquals(pb.loops[0].items, null);
});

Deno.test("loop: an iterable that throws on update is reported, and the next update recovers", () => {
	const desc: LoopDesc = { ...LOOP, snapshot: FOR({ iterable: expr('o.xs', ['o']) }) };
	const { el } = host(loop(li('A'), li('B')));
	const pb = new PatchBranch({ sites: [], sets: [], loops: [desc] }, el, { o: { xs: AB } });
	const { errors } = captureErrors(() => pb.update({}));
	assertEquals(errors.length, 1);
	assertEquals(TITLES(el), ['A', 'B']);
	pb.update({ o: { xs: [{ id: 1, name: 'New' }, AB[1]] } });
	assertEquals(TITLES(el), ['New', 'B']);
});

Deno.test("loop: a missing anchor is reported, and the loop stays as rendered", () => {
	const desc: LoopDesc = { ...LOOP, bfid: 'nope' };
	const { el } = host(loop(li('A')));
	const { result: pb, errors } = captureErrors(() => new PatchBranch({ sites: [], sets: [], loops: [desc] }, el, { xs: [AB[0]] }));
	assertEquals(errors.length, 1);
	assertEquals(pb.loops[0].items, null);
});

Deno.test("loop: missing markers are reported, and the loop stays as rendered", () => {
	const { el } = host(li('A'));
	const { result: pb, errors } = captureErrors(() => new PatchBranch(LOOP_ROOT, el, { xs: [AB[0]] }));
	assertEquals(errors.length, 1);
	assertEquals(pb.loops[0].items, null);
});

// Driven by a shell, the way a generated module drives it.

Deno.test("loop: a store change reaches the items through the shell", () => {
	const { el } = host(loop(li('A'), li('B')));
	const store = { data: { list: AB } };
	class Shell extends BackflipShell {
		static override bfStores = { store };
		static override bfRoot: BranchDesc = { sites: [], sets: [], loops: [{ ...LOOP, snapshot: FOR({ iterable: expr('store.data.list', ['store']) }) }] };
	}
	new Shell(el);
	const [first, second] = el.querySelectorAll('li');
	store.data = { list: [AB[0], { id: 2, name: 'New' }] };
	storeChanged(store);
	flush();
	assertEquals([first.title, second.title], ['A', 'New']);
});

// --- PatchBranch: b-for loops, adding, removing and moving items ---------------

const XS = (...ids: string[]) => ids.map(id => ({ id, name: id }));

// A rendered loop over items whose key and name are `ids`, with its branch and the
// element each id started with.
function started(...ids: string[]) {
	const { el, doc } = host(loop(...ids.map(li)));
	const pb = new PatchBranch(LOOP_ROOT, el, { xs: XS(...ids) });
	const nodes = Object.fromEntries(ids.map((id, i) => [id, el.querySelectorAll('li')[i]]));
	return { el, doc, pb, nodes };
}

// The nodes an update added or removed under `el`.
function touched(records: MutationRecord[]): Node[] {
	return records.flatMap(r => [...r.addedNodes, ...r.removedNodes]);
}

function permutations<T>(xs: T[]): T[][] {
	if (xs.length <= 1) return [xs];
	return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map(rest => [x, ...rest]));
}

for (const [label, before, after] of [
	['at the end', ['a', 'b'], ['a', 'b', 'c']],
	['at the start', ['a', 'b'], ['c', 'a', 'b']],
	['in the middle', ['a', 'b'], ['a', 'c', 'b']],
	['to an empty list', [], ['a', 'b']],
	['several at once, apart', ['a', 'b'], ['c', 'a', 'd', 'b', 'e']],
] as const) {
	Deno.test(`loop: an item added ${label} is rendered, and the existing items keep their nodes`, () => {
		const { el, pb, nodes } = started(...before);
		const { errors } = captureErrors(() => pb.update({ xs: XS(...after) }));
		assertEquals(errors, []);
		assertEquals(el.innerHTML, loop(...after.map(li)));
		for (const id of before) assertEquals(el.querySelectorAll('li')[(after as readonly string[]).indexOf(id)], nodes[id]);
	});
}

Deno.test("loop: adding an item at the end touches nothing else", () => {
	const { el, pb, nodes } = started('a', 'b');
	const records = mutations(el, () => pb.update({ xs: XS('a', 'b', 'c') }));
	const moved = touched(records);
	assertEquals(moved.includes(nodes.a), false);
	assertEquals(moved.includes(nodes.b), false);
	assertEquals(records.flatMap(r => [...r.removedNodes]), []);
});

Deno.test("loop: an added item patches on later updates", () => {
	const { el, pb } = started('a');
	pb.update({ xs: XS('a', 'b') });
	const { errors } = captureErrors(() => pb.update({ xs: [{ id: 'a', name: 'a' }, { id: 'b', name: 'new' }] }));
	assertEquals(errors, []);
	assertEquals(TITLES(el), ['a', 'new']);
});

Deno.test("loop: an added item is parsed in its parent's context", () => {
	const row: LoopDesc = {
		...LOOP, bfid: 't', snapshot: FOR({ nodes: [{ type: 'comment', text: 'it' }, { type: 'raw', raw: '<tr><td>' }, { type: 'print', data: expr('x.name', ['x']) }, { type: 'raw', raw: '</td></tr>' }] }),
		item: { sites: [], sets: [] },
	};
	const dom = new JSDOM(`<!DOCTYPE html><body><my-el><table><tbody data-bfid="t"><!--ls--><!--le--></tbody></table></my-el></body>`);
	const el = dom.window.document.querySelector('my-el')!;
	const pb = new PatchBranch({ sites: [], sets: [], loops: [row] }, el, { xs: [] });
	pb.update({ xs: XS('a') });
	assertEquals(el.querySelector('tbody')!.innerHTML, '<!--ls--><!--it--><tr><td>a</td></tr><!--le-->');
});

Deno.test("loop: an added item's value is written as text, escaped", () => {
	const { el, pb } = started();
	pb.update({ xs: [{ id: 'a', name: '"><b>x</b>' }] });
	assertEquals(el.querySelector('b'), null);
	assertEquals(TITLES(el), ['"><b>x</b>']);
});

for (const [label, before, after] of [
	['the first', ['a', 'b', 'c'], ['b', 'c']],
	['the last', ['a', 'b', 'c'], ['a', 'b']],
	['a middle', ['a', 'b', 'c'], ['a', 'c']],
	['every', ['a', 'b'], []],
] as const) {
	Deno.test(`loop: removing ${label} item removes its nodes and leaves the rest in place`, () => {
		const { el, pb, nodes } = started(...before);
		const records = mutations(el, () => pb.update({ xs: XS(...after) }));
		assertEquals(el.innerHTML, loop(...after.map(li)));
		for (const id of after) assertEquals(touched(records).includes(nodes[id]), false);
	});
}

Deno.test("loop: a removed item's whole range goes, however many nodes it has", () => {
	const multi: LoopDesc = { ...LOOP, item: { sites: [], sets: [] } };
	const body = (t: string) => `\n  <b>${t}</b>text<!--author--><i>${t}</i>\n`;
	const { el } = host(loop(body('1'), body('2'), body('3')));
	const pb = new PatchBranch({ sites: [], sets: [], loops: [multi] }, el, { xs: XS('a', 'b', 'c') });
	pb.update({ xs: XS('a', 'c') });
	assertEquals(el.innerHTML, loop(body('1'), body('3')));
});

Deno.test("loop: a removed item is no longer updated, and its key can come back as a new item", () => {
	const { el, pb, nodes } = started('a', 'b');
	pb.update({ xs: XS('a') });
	const { errors } = captureErrors(() => pb.update({ xs: XS('a') }));
	assertEquals(errors, []);
	pb.update({ xs: XS('a', 'b') });
	assertEquals(el.innerHTML, loop(li('a'), li('b')));
	assertEquals(el.querySelectorAll('li')[1] === nodes.b, false);
});

for (const order of permutations(['a', 'b', 'c', 'd'])) {
	Deno.test(`loop: moving to ${order.join('')} keeps every item's node`, () => {
		const { el, pb, nodes } = started('a', 'b', 'c', 'd');
		const { errors } = captureErrors(() => pb.update({ xs: XS(...order) }));
		assertEquals(errors, []);
		assertEquals(el.innerHTML, loop(...order.map(li)));
		assertEquals([...el.querySelectorAll('li')], order.map(id => nodes[id]));
	});
}

Deno.test("loop: a moved item's own state survives, since its DOM is never rebuilt", () => {
	const { el, pb, nodes } = started('a', 'b', 'c');
	(nodes.a as unknown as { mine: number }).mine = 1;
	pb.update({ xs: XS('c', 'b', 'a') });
	assertEquals((el.querySelectorAll('li')[2] as unknown as { mine: number }).mine, 1);
});

Deno.test("loop: an item already in place is not moved", () => {
	const { el, pb, nodes } = started('a', 'b', 'c', 'd');
	const records = mutations(el, () => pb.update({ xs: XS('a', 'c', 'b', 'd') }));
	const moved = touched(records);
	assertEquals(moved.includes(nodes.a), false);
	assertEquals(moved.includes(nodes.b), false);
	assertEquals(moved.includes(nodes.c), true);
	assertEquals(moved.includes(nodes.d), false);
});

Deno.test("loop: an order that did not change touches no nodes", () => {
	const { el, pb } = started('a', 'b', 'c');
	assertEquals(mutations(el, () => pb.update({ xs: XS('a', 'b', 'c') })), []);
});

Deno.test("loop: a moved item takes all its nodes, in order", () => {
	const multi: LoopDesc = { ...LOOP, item: { sites: [], sets: [] } };
	const body = (t: string) => `\n<b>${t}</b>text<!--author--><i>${t}</i>\n`;
	const { el } = host(loop(body('1'), body('2'), body('3')));
	const pb = new PatchBranch({ sites: [], sets: [], loops: [multi] }, el, { xs: XS('a', 'b', 'c') });
	pb.update({ xs: XS('c', 'a', 'b') });
	assertEquals(el.innerHTML, loop(body('3'), body('1'), body('2')));
});

Deno.test("loop: a moved item's data and index update too", () => {
	const desc: LoopDesc = {
		...LOOP, snapshot: FOR({ indexName: 'i' }),
		item: { sites: [{ bfid: 'x', attr: 'title', expr: expr('x.name + i', ['x', 'i']) }], sets: [] },
	};
	const { el } = host(loop(li('a0'), li('b1')));
	const pb = new PatchBranch({ sites: [], sets: [], loops: [desc] }, el, { xs: XS('a', 'b') });
	const [a, b] = el.querySelectorAll('li');
	pb.update({ xs: [{ id: 'b', name: 'B' }, { id: 'a', name: 'a' }] });
	assertEquals([...el.querySelectorAll('li')], [b, a]);
	assertEquals(TITLES(el), ['B0', 'a1']);
});

Deno.test("loop: added, removed, moved and changed items in one update", () => {
	const { el, pb, nodes } = started('a', 'b', 'c', 'd');
	pb.update({ xs: [{ id: 'd', name: 'D' }, { id: 'e', name: 'e' }, { id: 'a', name: 'a' }, { id: 'f', name: 'f' }, { id: 'b', name: 'b' }] });
	assertEquals(el.innerHTML, loop(li('D'), li('e'), li('a'), li('f'), li('b')));
	const lis = el.querySelectorAll('li');
	assertEquals([lis[0], lis[2], lis[4]], [nodes.d, nodes.a, nodes.b]);
});

Deno.test("loop: content around the loop stays put through changes", () => {
	const { el } = host(`<p>before</p>${loop(li('a'), li('b'))}<p>after</p>`);
	const pb = new PatchBranch(LOOP_ROOT, el, { xs: XS('a', 'b') });
	pb.update({ xs: XS('c', 'b', 'a') });
	assertEquals(el.innerHTML, `<p>before</p>${loop(li('c'), li('b'), li('a'))}<p>after</p>`);
});

Deno.test("loop: anchored to an element, its items change inside that element", () => {
	const { el } = host(`<ul data-bfid="u">${loop(li('a'), li('b'))}</ul>`);
	const pb = new PatchBranch({ sites: [], sets: [], loops: [{ ...LOOP, bfid: 'u' }] }, el, { xs: XS('a', 'b') });
	pb.update({ xs: XS('b', 'c') });
	assertEquals(el.innerHTML, `<ul data-bfid="u">${loop(li('b'), li('c'))}</ul>`);
});

// moveBefore, where the browser has it.

for (const available of [true, false]) {
	Deno.test(`loop: moves ${available ? 'with moveBefore when available' : 'with insertBefore otherwise'}`, () => {
		const { el, pb, nodes } = started('a', 'b');
		const calls: Node[] = [];
		if (available) {
			(el as unknown as { moveBefore: (n: Node, ref: Node) => void }).moveBefore = (n, ref) => {
				calls.push(n);
				el.insertBefore(n, ref);
			};
		}
		pb.update({ xs: XS('b', 'a') });
		assertEquals([...el.querySelectorAll('li')], [nodes.b, nodes.a]);
		assertEquals(calls.includes(nodes.b), available);
	});
}

// Items holding sets and loops of their own.

Deno.test("loop: an added item's b-if works, and a moved item's keeps working", () => {
	const nodes = [
		{ type: 'comment', text: 'it' }, { type: 'comment', text: 's0' }, ITEM_SET.snapshot, { type: 'comment', text: 's1' },
	] as ForRNode['nodes'];
	const desc: LoopDesc = { ...LOOP, snapshot: FOR({ nodes }), item: { sites: [], sets: [ITEM_SET] } };
	const { el } = host(loop(on));
	const pb = new PatchBranch({ sites: [], sets: [], loops: [desc] }, el, { xs: [{ id: 1, on: true }] });
	const { errors } = captureErrors(() => {
		pb.update({ xs: [{ id: 2, on: false }, { id: 1, on: true }] });
		pb.update({ xs: [{ id: 2, on: true }, { id: 1, on: false }] });
	});
	assertEquals(errors, []);
	assertEquals(el.innerHTML, loop(on, off));
});

const ROW = (id: string, ...cells: string[]) => ({ id, tag: '', cells: cells.map(c => ({ id: c, name: c })) });

for (const [label, bfid, row] of [
	['under the same parent', null, (...items: string[]) => innerLoop(...items)],
	['in an element', 'u', (...items: string[]) => `<ul data-bfid="u">${innerLoop(...items)}</ul>`],
] as const) {
	Deno.test(`loop: nested ${label}, an inner loop adds, removes and moves within its outer item`, () => {
		const { el } = host(loop(row(li('a'), li('b')), row(li('c'))));
		const pb = new PatchBranch(OUTER_LOOP(INNER_LOOP(bfid)), el, { rows: [ROW('r1', 'a', 'b'), ROW('r2', 'c')] });
		const { errors } = captureErrors(() => pb.update({ rows: [ROW('r1', 'b', 'z', 'a'), ROW('r2')] }));
		assertEquals(errors, []);
		assertEquals(el.innerHTML, loop(row(li('b'), li('z'), li('a')), row()));
	});

	Deno.test(`loop: nested ${label}, a moved outer item keeps its inner items' nodes and keeps patching`, () => {
		const { el } = host(loop(row(li('a'), li('b')), row(li('c'))));
		const pb = new PatchBranch(OUTER_LOOP(INNER_LOOP(bfid)), el, { rows: [ROW('r1', 'a', 'b'), ROW('r2', 'c')] });
		const [a, b, c] = el.querySelectorAll('li');
		const { errors } = captureErrors(() => {
			pb.update({ rows: [ROW('r2', 'c'), ROW('r1', 'a', 'b')] });
			pb.update({ rows: [ROW('r2', 'c', 'n'), ROW('r1', 'b', 'a')] });
		});
		assertEquals(errors, []);
		assertEquals(el.innerHTML, loop(row(li('c'), li('n')), row(li('b'), li('a'))));
		const lis = el.querySelectorAll('li');
		assertEquals([lis[0], lis[2], lis[3]], [c, b, a]);
	});

	Deno.test(`loop: nested ${label}, an added outer item renders its inner loop, which then patches`, () => {
		const { el } = host(loop(row(li('a'))));
		const pb = new PatchBranch(OUTER_LOOP(INNER_LOOP(bfid)), el, { rows: [ROW('r1', 'a')] });
		const { errors } = captureErrors(() => {
			pb.update({ rows: [ROW('r1', 'a'), ROW('r2', 'b')] });
			pb.update({ rows: [ROW('r1', 'a'), ROW('r2', 'c', 'b')] });
		});
		assertEquals(errors, []);
		assertEquals(el.innerHTML, loop(row(li('a')), row(li('c'), li('b'))));
	});
}

// What goes wrong while changing the items.

Deno.test("loop: an added item that fails to render is reported, nothing changes, and the next update recovers", () => {
	const { el, pb } = started('a', 'b');
	const before = el.innerHTML;
	const { errors } = captureErrors(() => pb.update({ xs: [{ id: 'c', get name() { throw new Error('boom'); } }, { id: 'a', name: 'new' }] }));
	assertEquals(errors.length, 1);
	assertEquals(el.innerHTML, before);
	pb.update({ xs: XS('c', 'a') });
	assertEquals(el.innerHTML, loop(li('c'), li('a')));
});

Deno.test("loop: markers gone when items change are reported, nothing changes, and the next update recovers", () => {
	const { el, pb } = started('a', 'b');
	const end = [...el.childNodes].find(c => c.nodeValue === 'le')!;
	end.remove();
	const before = el.innerHTML;
	const { errors } = captureErrors(() => pb.update({ xs: XS('b', 'a') }));
	assertEquals(errors.length, 1);
	assertEquals(el.innerHTML, before);
	el.append(end);
	pb.update({ xs: XS('b', 'a') });
	assertEquals(el.innerHTML, loop(li('b'), li('a')));
});

// Driven by a shell, the way a generated module drives it.

Deno.test("loop: store changes add, remove and move items through the shell", () => {
	const { el } = host(loop(li('a'), li('b'), li('c')));
	const store = { data: { list: XS('a', 'b', 'c') } };
	class Shell extends BackflipShell {
		static override bfStores = { store };
		static override bfRoot: BranchDesc = { sites: [], sets: [], loops: [{ ...LOOP, snapshot: FOR({ iterable: expr('store.data.list', ['store']) }) }] };
	}
	new Shell(el);
	const [a, , c] = el.querySelectorAll('li');
	store.data = { list: XS('c', 'd', 'a') };
	storeChanged(store);
	flush();
	assertEquals(el.innerHTML, loop(li('c'), li('d'), li('a')));
	const lis = el.querySelectorAll('li');
	assertEquals([lis[0], lis[2]], [c, a]);
});
