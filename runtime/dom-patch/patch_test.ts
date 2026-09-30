import { assertEquals } from "jsr:@std/assert";
import { JSDOM } from "npm:jsdom";

import { BackflipElement, BackflipShell, PatchBranch, replaceBetween, type BranchDesc, type SetDesc } from "./patch.ts";
import type { IfRNode, rfn } from "../js/render.ts";

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

Deno.test("PatchBranch: an attr site is set from its expression when one of its vars changes", () => {
	const { el } = host(`<p data-bfid="p">x</p>`);
	const pb = new PatchBranch({ sites: [{ bfid: 'p', attr: 'title', expr: expr('a + "-" + b', ['a', 'b']) }], sets: [] }, el, {});
	pb.update('b', { a: 1, b: 2 });
	assertEquals(el.querySelector('p')!.getAttribute('title'), '1-2');
	// A var the site does not use leaves it alone.
	pb.update('z', { a: 9, b: 9 });
	assertEquals(el.querySelector('p')!.getAttribute('title'), '1-2');
});

Deno.test("PatchBranch: a bool attr site is present or absent", () => {
	const { el } = host(`<p data-bfid="p">x</p>`);
	const pb = new PatchBranch({ sites: [{ bfid: 'p', attr: 'hidden', bool: true, expr: expr('on', ['on']) }], sets: [] }, el, {});
	pb.update('on', { on: true });
	assertEquals(el.querySelector('p')!.getAttribute('hidden'), '');
	pb.update('on', { on: false });
	assertEquals(el.querySelector('p')!.hasAttribute('hidden'), false);
});

Deno.test("PatchBranch: a print site replaces its marker range with text, never markup", () => {
	const { el } = host(`<p data-bfid="p">Hi <!--m0-->x<!--m1-->!</p>`);
	const pb = new PatchBranch({ sites: [{ bfid: 'p', markers: ['m0', 'm1'], expr: expr('name', ['name']) }], sets: [] }, el, {});
	pb.update('name', { name: '<b>Mars</b>' });
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
	pb.update('c', { c: 'on' });
	assertEquals(el.getAttribute('class'), 'on');
	assertEquals(el.textContent, 'on');
});

Deno.test("PatchBranch: sites sharing an element look it up once per update", () => {
	const { el } = host(`<p data-bfid="p">x</p>`);
	const pb = new PatchBranch({ sites: [
		{ bfid: 'p', attr: 'title', expr: expr('v', ['v']) },
		{ bfid: 'p', attr: 'aria-label', expr: expr('v', ['v']) },
	], sets: [] }, el, {});
	let lookups = 0;
	const orig = el.querySelector.bind(el);
	(el as any).querySelector = (sel: string) => { lookups++; return orig(sel); };
	pb.update('v', { v: 'x' });
	assertEquals(lookups, 1);
	assertEquals(el.querySelector('p')!.getAttribute('aria-label'), 'x');
});

Deno.test("PatchBranch: a missing element is reported and the other sites still patch", () => {
	const { el } = host(`<p data-bfid="p">x</p>`);
	const pb = new PatchBranch({ sites: [
		{ bfid: 'gone', attr: 'title', expr: expr('v', ['v']) },
		{ bfid: 'p', attr: 'title', expr: expr('v', ['v']) },
	], sets: [] }, el, {});
	const { errors } = captureErrors(() => pb.update('v', { v: 'x' }));
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
	bfid: null, markers: ['s0', 's1'], snapshot: SET_SNAPSHOT, subtreeVars: ['name'],
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

Deno.test("PatchBranch: a condition var swaps the branch, and back, keeping the markers", () => {
	const { el } = host(SERVER_A);
	const pb = new PatchBranch({ sites: [], sets: [SET] }, el, { mode: 'a', name: 'World' });
	pb.update('mode', { mode: 'b', name: 'World' });
	assertEquals(el.querySelector('p'), null);
	assertEquals(el.querySelector('em')!.textContent, 'none');
	pb.update('mode', { mode: 'a', name: 'World' });
	assertEquals(el.querySelector('p')!.textContent, 'Hi World');
	const comments = [...el.childNodes].filter(n => n.nodeType === 8).map(n => n.nodeValue);
	assertEquals(comments, ['s0', 'b0', 's1']);
});

Deno.test("PatchBranch: an unchanged winning branch is not re-rendered", () => {
	const { el } = host(SERVER_A);
	const pb = new PatchBranch({ sites: [], sets: [SET] }, el, { mode: 'a', name: 'World' });
	const p = el.querySelector('p');
	pb.update('mode', { mode: 'a', name: 'World' });
	assertEquals(el.querySelector('p'), p);
});

Deno.test("PatchBranch: with no b-else and no match, the set renders nothing", () => {
	const { el } = host(SERVER_A);
	const pb = new PatchBranch({ sites: [], sets: [SET_NO_ELSE] }, el, { mode: 'a', name: 'W' });
	pb.update('mode', { mode: 'z', name: 'W' });
	assertEquals(el.innerHTML, SERVER_NONE);
});

Deno.test("PatchBranch: a subtree var is forwarded to the active branch", () => {
	const { el } = host(SERVER_A);
	const pb = new PatchBranch({ sites: [], sets: [SET] }, el, { mode: 'a', name: 'World' });
	const p = el.querySelector('p');
	pb.update('name', { mode: 'a', name: 'Mars' });
	assertEquals(el.querySelector('p'), p);   // patched in place, not re-rendered
	assertEquals(p!.textContent, 'Hi Mars');
});

Deno.test("PatchBranch: a swapped-in branch gets a fresh patch-branch that keeps patching", () => {
	const { el } = host(SERVER_A);
	const pb = new PatchBranch({ sites: [], sets: [SET] }, el, { mode: 'a', name: 'World' });
	pb.update('mode', { mode: 'b', name: 'World' });
	// Changed while its branch is out: nothing to forward to.
	pb.update('name', { mode: 'b', name: 'Mars' });
	pb.update('mode', { mode: 'a', name: 'Mars' });
	assertEquals(el.querySelector('p')!.textContent, 'Hi Mars');
	pb.update('name', { mode: 'a', name: 'Venus' });
	assertEquals(el.querySelector('p')!.textContent, 'Hi Venus');
});

Deno.test("PatchBranch: a var in both the conditions and the subtree re-renders or forwards", () => {
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
	const set: SetDesc = { bfid: null, markers: ['s0', 's1'], snapshot, subtreeVars: ['mode'], branches: [branch, null], branchMarkers: ['b0', 'b1'] };
	const { el } = host(`<!--s0--><!--b0--><p data-bfid="p"><!--n0-->x<!--n1--></p><!--s1-->`);
	const pb = new PatchBranch({ sites: [], sets: [set] }, el, { mode: 'x' });
	const p = el.querySelector('p');
	// Same branch: forwarded, patched in place.
	pb.update('mode', { mode: 'y' });
	assertEquals(el.querySelector('p'), p);
	assertEquals(p!.textContent, 'y');
	// Different branch: re-rendered.
	pb.update('mode', { mode: 'off' });
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
const INNER_SET: SetDesc = { bfid: 'd', markers: ['i0', 'i1'], snapshot: INNER, subtreeVars: [], branches: [null, null], branchMarkers: ['ib0', 'ib1'] };
const OUTER_SET: SetDesc = {
	bfid: null, markers: ['o0', 'o1'], snapshot: OUTER, subtreeVars: ['sub'],
	branches: [{ sites: [], sets: [INNER_SET] }, null], branchMarkers: ['ob0', 'ob1'],
};

Deno.test("PatchBranch: a nested set swaps only its own range", () => {
	const { el } = host(`<!--o0--><!--ob0--><div data-bfid="d"><!--i0--><!--ib0--><b>X</b><!--i1--></div><!--o1-->`);
	const pb = new PatchBranch({ sites: [], sets: [OUTER_SET] }, el, { on: true, sub: 'x' });
	const div = el.querySelector('div');
	pb.update('sub', { on: true, sub: 'y' });
	assertEquals(el.querySelector('div'), div);   // the outer branch stayed
	assertEquals(div!.innerHTML, '<!--i0--><!--ib1--><i>Y</i><!--i1-->');
});

// --- PatchBranch: the rendered branch is read from the DOM ------------------
//
// Data that changed before the patch-branch was built must not be mistaken for what
// the server rendered.

Deno.test("PatchBranch: DOM on branch 0, data on branch 1: the update renders branch 1", () => {
	const { el } = host(SERVER_A);
	const pb = new PatchBranch({ sites: [], sets: [SET] }, el, { mode: 'b', name: 'World' });
	pb.update('mode', { mode: 'b', name: 'World' });
	assertEquals(el.innerHTML, SERVER_ELSE);
});

Deno.test("PatchBranch: DOM on branch 1, data on branch 0: the update renders branch 0 and it patches", () => {
	const { el } = host(SERVER_ELSE);
	const { errors } = captureErrors(() => {
		const pb = new PatchBranch({ sites: [], sets: [SET] }, el, { mode: 'a', name: 'World' });
		pb.update('mode', { mode: 'a', name: 'World' });
		pb.update('name', { mode: 'a', name: 'Mars' });
	});
	assertEquals(errors, []);
	assertEquals(el.querySelector('p')!.textContent, 'Hi Mars');
});

Deno.test("PatchBranch: DOM with no branch, data on branch 0: the update renders branch 0", () => {
	const { el } = host(SERVER_NONE);
	const pb = new PatchBranch({ sites: [], sets: [SET_NO_ELSE] }, el, { mode: 'a', name: 'World' });
	pb.update('mode', { mode: 'a', name: 'World' });
	assertEquals(el.querySelector('p')!.textContent, 'Hi World');
});

Deno.test("PatchBranch: DOM on branch 0, data on no branch: the update empties the set", () => {
	const { el } = host(SERVER_A);
	const pb = new PatchBranch({ sites: [], sets: [SET_NO_ELSE] }, el, { mode: 'z', name: 'World' });
	pb.update('mode', { mode: 'z', name: 'World' });
	assertEquals(el.innerHTML, SERVER_NONE);
});

Deno.test("PatchBranch: a nested set reads its own rendered branch from the DOM", () => {
	const { el } = host(`<!--o0--><!--ob0--><div data-bfid="d"><!--i0--><!--ib0--><b>X</b><!--i1--></div><!--o1-->`);
	const pb = new PatchBranch({ sites: [], sets: [OUTER_SET] }, el, { on: true, sub: 'y' });
	pb.update('sub', { on: true, sub: 'y' });
	assertEquals(el.querySelector('div')!.innerHTML, '<!--i0--><!--ib1--><i>Y</i><!--i1-->');
});

Deno.test("PatchBranch: a set whose markers are missing is reported and treated as rendering nothing", () => {
	const { el } = host(`<p data-bfid="p">Hi</p>`);
	const { errors } = captureErrors(() => new PatchBranch({ sites: [], sets: [SET] }, el, { mode: 'a', name: 'W' }));
	assertEquals(errors.length, 1);
	assertEquals(String(errors[0][0]).includes('comment markers s0 / s1 not found'), true);
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

Deno.test("BackflipShell: update patches from the element's current attributes", () => {
	const { el } = host(`<p data-bfid="p"><!--m0-->x<!--m1--></p>`);
	el.setAttribute('name', 'World');
	class Shell extends BackflipShell {
		static override bfAttrs = { name: 'string' } as const;
		static override bfRoot: BranchDesc = { sites: [{ bfid: 'p', markers: ['m0', 'm1'], expr: expr('name', ['name']) }], sets: [] };
	}
	const shell = new Shell(el);
	el.setAttribute('name', 'Mars');
	shell.update('name');
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
