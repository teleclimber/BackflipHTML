import { assertEquals } from "jsr:@std/assert";
import { collectRefSites, refSitesFor } from "./partial-refs.ts";
import { compileFiles } from "./partials.ts";
import type { CompiledFile, TNode } from "./types.ts";

function partialRef(partialName: string, file: string | null, slots: { [k: string]: TNode[] } = {}): TNode {
	return { type: 'partial-ref', kind: 'b-part', file, partialName, bindings: [], slots };
}

function files(spec: { [file: string]: { [partial: string]: TNode[] } }): Map<string, CompiledFile> {
	const out = new Map<string, CompiledFile>();
	for (const [file, partials] of Object.entries(spec)) {
		const map = new Map<string, any>();
		for (const [name, tnodes] of Object.entries(partials)) map.set(name, { tnodes });
		out.set(file, { partials: map });
	}
	return out;
}

function sitesOf(spec: Parameters<typeof files>[0], partialName: string, defFile: string) {
	return refSitesFor(collectRefSites(files(spec)), partialName, defFile);
}

// --- collectRefSites ---

Deno.test("collectRefSites records the partial each call is written inside", () => {
	const sites = collectRefSites(files({
		'ui.html': { btn: [], demo: [partialRef('btn', null)] },
	}));
	assertEquals(sites.length, 1);
	assertEquals(sites[0].file, 'ui.html');
	assertEquals(sites[0].fromPartial, 'demo');
	assertEquals(sites[0].partialName, 'btn');
	assertEquals(sites[0].targetFile, null);
});

Deno.test("collectRefSites finds calls nested in every child container", () => {
	const sites = collectRefSites(files({
		'a.html': {
			caller: [
				{ type: 'element', tagName: 'div', attrs: [], tnodes: [partialRef('in_elem', null)] },
				{ type: 'for', iterable: { errs: [], vars: [], expr: null } as any, valName: 'x', tnodes: [partialRef('in_for', null)] },
				{ type: 'if', branches: [{ tnodes: [partialRef('in_if', null)] }] },
				partialRef('outer', null, { default: [partialRef('in_slot', null)] }),
			],
		},
	}));
	assertEquals(sites.map(s => s.partialName), ['in_elem', 'in_for', 'in_if', 'outer', 'in_slot']);
	// Slot content lives in the caller's tree, so it is attributed to the caller.
	assertEquals(sites.every(s => s.fromPartial === 'caller'), true);
});

Deno.test("collectRefSites carries data bindings and filled slots", () => {
	const ref: TNode = {
		type: 'partial-ref', kind: 'b-part', file: 'c.html', partialName: 'card',
		bindings: [{ name: 'title' } as any, { name: 'items' } as any],
		slots: { default: [], header: [] },
	};
	const sites = collectRefSites(files({ 'page.html': { p: [ref] } }));
	assertEquals(sites[0].dataBindings, ['title', 'items']);
	assertEquals(sites[0].slotsFilled, ['default', 'header']);
});

// --- refSitesFor ---

Deno.test("refSitesFor counts every call site, not every caller", () => {
	const spec = {
		'ui.html': {
			btn: [],
			demo: [partialRef('btn', null), partialRef('btn', null), partialRef('btn', null)],
		},
	};
	assertEquals(sitesOf(spec, 'btn', 'ui.html').length, 3);
});

Deno.test("refSitesFor resolves a file-less call within the file it was written in", () => {
	const spec = {
		'a.html': { btn: [], demo: [partialRef('btn', null)] },
		'b.html': { btn: [], other: [partialRef('btn', null)] },
	};
	assertEquals(sitesOf(spec, 'btn', 'a.html').map(s => s.file), ['a.html']);
	assertEquals(sitesOf(spec, 'btn', 'b.html').map(s => s.file), ['b.html']);
});

Deno.test("refSitesFor resolves a cross-file call to the file it names", () => {
	const spec = {
		'components.html': { label: [] },
		'page.html': { labeled: [partialRef('label', 'components.html')] },
	};
	const sites = sitesOf(spec, 'label', 'components.html');
	assertEquals(sites.length, 1);
	assertEquals(sites[0].file, 'page.html');
	assertEquals(sites[0].fromPartial, 'labeled');
	// The call is not counted against a same-named partial in its own file.
	assertEquals(sitesOf(spec, 'label', 'page.html').length, 0);
});

Deno.test("refSitesFor ignores calls to other partials", () => {
	const spec = { 'a.html': { btn: [], demo: [partialRef('other', null)] } };
	assertEquals(sitesOf(spec, 'btn', 'a.html').length, 0);
});

Deno.test("refSitesFor counts nothing for an unresolved custom element", () => {
	const spec = {
		'a.html': { caller: [{ type: 'partial-ref', kind: 'custom-element', file: '__unresolved_custom_element__', partialName: 'my-widget', bindings: [], slots: {} } as TNode] },
	};
	assertEquals(sitesOf(spec, 'my-widget', 'a.html').length, 0);
});

// --- against real compiled templates ---

Deno.test("counts references across compiled files", async () => {
	const { directory } = await compileFiles(new Map([
		['ui.html', `<button b-name="btn"><b-unwrap b-slot /></button>
<b-unwrap b-name="demo"><div b-part="#btn">a</div><div b-part="#btn">b</div></b-unwrap>`],
		['page.html', `<b-unwrap b-name="labeled"><b-unwrap b-part="ui.html#btn">x</b-unwrap></b-unwrap>`],
	]));
	const sites = collectRefSites(directory.files);

	const btn = refSitesFor(sites, 'btn', 'ui.html');
	assertEquals(btn.length, 3);
	assertEquals(btn.map(s => `${s.file}#${s.fromPartial}`), ['ui.html#demo', 'ui.html#demo', 'page.html#labeled']);
	assertEquals(refSitesFor(sites, 'demo', 'ui.html').length, 0);
});

Deno.test("resolves custom element calls the linker pointed at another file", async () => {
	const { directory } = await compileFiles(new Map([
		['widgets.html', `<my-card b-export><b-unwrap b-slot /></my-card>`],
		['page.html', `<b-unwrap b-name="uses"><my-card>hi</my-card></b-unwrap>`],
	]));
	const sites = refSitesFor(collectRefSites(directory.files), 'my-card', 'widgets.html');
	assertEquals(sites.length, 1);
	assertEquals(sites[0].file, 'page.html');
	assertEquals(sites[0].fromPartial, 'uses');
});
