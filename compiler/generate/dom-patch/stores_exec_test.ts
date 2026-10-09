// Behavioral tests for generated shells that read stores: the generated code, the real
// patch runtime and the real BackflipStore, against a jsdom document that carries the
// store's JSON tag the way a page render ships it.
//
// Like exec_test.ts, this does not import the compiler (jsdom and the compiler's
// parse5 cannot load together); the codegen input is built by hand.
import { assertEquals, assertThrows } from "jsr:@std/assert";
import { JSDOM } from "npm:jsdom";

import type { IfBranch, IfTNode, PrintTNode } from "../../types.ts";
import { interpretBackcode } from "../../backcode.ts";
import { BackflipShell } from "../../../runtime/dom-patch/patch.ts";
import { BackflipStore } from "../../../runtime/dom-patch/stores.ts";
import type { BackcodeSite, IfSetSite } from "./collect.ts";
import { generateClassForPartial, type BfidSite, type IfSetPatchSite, type PatchBranch, type PatchTarget } from "./codegen.ts";

const WIDGETS = { '42': { name: 'Gizmo' }, '7': { name: 'Widget' }, title: 'Shop', on: true, label: 'from store' };
const TAG = `<script type="application/json" data-bf-store="widgets">${JSON.stringify(WIDGETS)}</script>`;

function printSite(target: PatchTarget, code: string, startId: string, endId: string): BfidSite {
	const node: PrintTNode = { type: 'print', data: interpretBackcode(code) };
	const parsed = interpretBackcode(code);
	const backcode: BackcodeSite = {
		site: { kind: 'print', node, container: [node], parentElement: null },
		parsed, liveVars: parsed.vars, inForLoop: false,
	};
	return { target, backcode, comments: { startId, endId } };
}

function ifSite(conditions: (string | null)[], snapshot: string, subtreeVars: string[], branches: (PatchBranch | null)[]): IfSetPatchSite {
	const brs: IfBranch[] = conditions.map(c => c === null ? { tnodes: [] } : { condition: interpretBackcode(c), tnodes: [] });
	const node: IfTNode = { type: 'if', branches: brs };
	const liveVars = [...new Set(conditions.flatMap(c => c === null ? [] : interpretBackcode(c).vars))];
	const set: IfSetSite = { kind: 'if-set', node, container: [node], parentElement: null, liveVars, inForLoop: false };
	return { target: { kind: 'ref-element' }, ifSet: set, setId: 's0', endId: 's1', snapshot, subtreeVars, branches };
}

function patchBranch(sites: BfidSite[] = [], sets: IfSetPatchSite[] = []): PatchBranch {
	const vars = [...new Set([...sites.flatMap(s => s.backcode.liveVars), ...sets.flatMap(s => [...s.ifSet.liveVars, ...s.subtreeVars])])];
	return { sites, sets, vars };
}

// Mount the generated shell on a `<my-widget>` built from `innerHtml`, in a document
// that carries the widgets store tag. The store is imported the way the module's
// `import bfstore_widgets from '…'` would supply it.
function mount(js: string, hostAttrs: string, innerHtml: string) {
	const dom = new JSDOM(`<!DOCTYPE html><body><my-widget ${hostAttrs}>${innerHtml}</my-widget>${TAG}</body>`);
	const doc = dom.window.document;
	const g = globalThis as { document?: Document };
	g.document = doc;
	const store = new BackflipStore('widgets');
	const src = js.replace(/^import .*$/gm, '').replaceAll('export class', 'class');
	const Cls = new Function('BackflipShell', 'bfstore_widgets', `${src}; return BackflipMyWidget;`)(BackflipShell, store);
	const host = doc.querySelector('my-widget')!;
	return { dom, host, instance: new Cls(host), store };
}

function mutations(dom: JSDOM, el: Element, f: () => void): MutationRecord[] {
	const obs = new dom.window.MutationObserver(() => {});
	obs.observe(el, { subtree: true, childList: true, attributes: true, characterData: true });
	f();
	const records = obs.takeRecords();
	obs.disconnect();
	return records;
}

function cleanup() {
	delete (globalThis as { document?: Document }).document;
}

Deno.test("exec stores: a mixed expression re-patches when its attribute changes, reading the store", () => {
	try {
		const root = patchBranch([printSite({ kind: 'bfid-element', bfid: 'h' }, 'widgets.data[widget_id].name', 'm0', 'm1')]);
		const js = generateClassForPartial('my-widget', [{ name: 'widget_id', isBool: false }], root, 'render', ['widgets'])!;
		const { dom, host, instance } = mount(js, 'widget_id="42"', `<h3 data-bfid="h"><!--bfid:m0-->Gizmo<!--bfid:m1--></h3>`);
		assertEquals(mutations(dom, host, () => instance.update()), []);
		host.setAttribute('widget_id', '7');
		instance.update('widget_id');
		assertEquals(host.querySelector('h3')!.textContent, 'Widget');
	} finally {
		cleanup();
	}
});

Deno.test("exec stores: a store-only site is left alone on init and by attribute changes", () => {
	try {
		const root = patchBranch([
			printSite({ kind: 'bfid-element', bfid: 'h' }, 'widgets.data.title', 'm0', 'm1'),
			printSite({ kind: 'bfid-element', bfid: 'p' }, 'label', 'm2', 'm3'),
		]);
		const js = generateClassForPartial('my-widget', [{ name: 'label', isBool: false }], root, 'render', ['widgets'])!;
		const { dom, host, instance } = mount(js, 'label="x"', `<h3 data-bfid="h"><!--bfid:m0-->Shop<!--bfid:m1--></h3><p data-bfid="p"><!--bfid:m2-->x<!--bfid:m3--></p>`);
		assertEquals(mutations(dom, host, () => instance.update()), []);
		const h3 = host.querySelector('h3')!;
		host.setAttribute('label', 'y');
		const records = mutations(dom, host, () => instance.update('label'));
		assertEquals(records.some(r => h3.contains(r.target)), false);
		assertEquals(host.querySelector('p')!.textContent, 'y');
	} finally {
		cleanup();
	}
});

const STORE_SET_SNAPSHOT = `{ type:'if', branches: [
	{ condition: { fn: function (widgets) { return widgets.data.on; }, vars: ['widgets'] }, nodes: [ { type:'comment', text:'bfid:s0:0' }, { type:'raw', raw:'<p>on</p>' } ] },
	{ nodes: [ { type:'comment', text:'bfid:s0:1' }, { type:'raw', raw:'<p>off</p>' } ] }
] }`;

Deno.test("exec stores: a store-driven reactive set keeps the branch the server rendered", () => {
	try {
		const set = ifSite(['widgets.data.on', null], STORE_SET_SNAPSHOT, [], [null, null]);
		const js = generateClassForPartial('my-widget', [], patchBranch([], [set]), 'render', ['widgets'])!;
		const { dom, host, instance } = mount(js, '', `<!--bfid:s0--><!--bfid:s0:0--><p>on</p><!--bfid:s1-->`);
		const p = host.querySelector('p')!;
		assertEquals(mutations(dom, host, () => instance.update()), []);
		assertEquals(host.querySelector('p'), p);
	} finally {
		cleanup();
	}
});

const MODE_SET_SNAPSHOT = `{ type:'if', branches: [
	{ condition: { fn: function (mode) { return mode == 'a'; }, vars: ['mode'] }, nodes: [ { type:'comment', text:'bfid:s0:0' }, { type:'raw', raw:'<p>a</p>' } ] },
	{ nodes: [ { type:'comment', text:'bfid:s0:1' }, { type:'raw', raw:'<p>' }, { type:'print', data: { fn: function (widgets) { return widgets.data.label; }, vars: ['widgets'] } }, { type:'raw', raw:'</p>' } ] }
] }`;

Deno.test("exec stores: a branch rendered in the browser reads the store", () => {
	try {
		const set = ifSite([`mode == 'a'`, null], MODE_SET_SNAPSHOT, ['widgets'], [null, null]);
		const js = generateClassForPartial('my-widget', [{ name: 'mode', isBool: false }], patchBranch([], [set]), 'render', ['widgets'])!;
		const { host, instance } = mount(js, 'mode="a"', `<!--bfid:s0--><!--bfid:s0:0--><p>a</p><!--bfid:s1-->`);
		host.setAttribute('mode', 'b');
		instance.update('mode');
		assertEquals(host.querySelector('p')!.textContent, 'from store');
	} finally {
		cleanup();
	}
});

Deno.test("exec stores: the shell hands the store itself to patching, and its data cannot be written", () => {
	try {
		const root = patchBranch([printSite({ kind: 'bfid-element', bfid: 'h' }, 'widgets.data.title', 'm0', 'm1')]);
		const js = generateClassForPartial('my-widget', [], root, 'render', ['widgets'])!;
		const { instance, store } = mount(js, '', `<h3 data-bfid="h"><!--bfid:m0-->Shop<!--bfid:m1--></h3>`);
		const data = instance.collectData();
		assertEquals(data.widgets, store);
		assertThrows(() => { (store.data as Record<string, unknown>).title = 'x'; }, TypeError);
	} finally {
		cleanup();
	}
});
