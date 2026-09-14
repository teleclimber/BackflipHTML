import { assertEquals } from "jsr:@std/assert";
import { buildPartialGraph, callsIn, partialKey } from "./partial-graph.ts";
import { compileFiles } from "./partials.ts";
import type { PartialBodyItem, PartialCall, PartialGraph } from "./partial-graph.ts";
import type { CompiledFile } from "./types.ts";

async function graphOf(sources: { [file: string]: string }): Promise<PartialGraph> {
	const { directory } = await compileFiles(new Map(Object.entries(sources)));
	return buildPartialGraph(directory.files);
}

/** The body of one partial, as `kind:name` strings. */
function shape(items: PartialBodyItem[]): string[] {
	return items.map(i => i.kind === 'slot' ? `slot:${i.name}` : `call:${i.partialName}`);
}

function bodyOf(graph: PartialGraph, file: string, name: string): PartialBodyItem[] {
	return graph.nodes.get(partialKey(file, name))!.body;
}

function callOf(graph: PartialGraph, file: string, name: string, index = 0): PartialCall {
	return bodyOf(graph, file, name).filter(i => i.kind === 'call')[index] as PartialCall;
}

// --- body: calls and slot declarations in source order ---

Deno.test("body flattens element, b-if and b-for nesting onto the partial", async () => {
	const graph = await graphOf({
		'a.html': `<b-unwrap b-name="leaf">x</b-unwrap>
<b-unwrap b-name="caller">
	<div><b-unwrap b-part="#leaf" /></div>
	<b-unwrap b-for="x in items" b-part="#leaf" />
	<b-unwrap b-if="show" b-part="#leaf" />
</b-unwrap>`,
	});
	assertEquals(shape(bodyOf(graph, 'a.html', 'caller')), ['call:leaf', 'call:leaf', 'call:leaf']);
});

Deno.test("body records slot declarations in source order alongside calls", async () => {
	const graph = await graphOf({
		'a.html': `<b-unwrap b-name="leaf">x</b-unwrap>
<div b-name="card">H(<b-unwrap b-slot="header" />)<b-unwrap b-part="#leaf" />B(<b-unwrap b-slot />)</div>`,
	});
	assertEquals(shape(bodyOf(graph, 'a.html', 'card')), ['slot:header', 'call:leaf', 'slot:default']);
});

Deno.test("declared slots are listed in source order, without repeats", async () => {
	const graph = await graphOf({
		'a.html': `<div b-name="twice"><b-unwrap b-slot="head" /><b-unwrap b-slot /><b-unwrap b-slot="head" /></div>`,
	});
	assertEquals(graph.nodes.get(partialKey('a.html', 'twice'))!.slots, ['head', 'default']);
});

// --- fills hang off the call ---

Deno.test("a call written inside slot content belongs to the call it fills", async () => {
	const graph = await graphOf({
		'a.html': `<b-unwrap b-name="chip">[chip]</b-unwrap>
<div b-name="card">H(<b-unwrap b-slot="header" />)B(<b-unwrap b-slot />)</div>
<div b-name="page">
	<b-unwrap b-part="#card"><b-unwrap b-in="header" b-part="#chip" />body</b-unwrap>
</div>`,
	});
	// The page's body holds one call: the card. The chip sits in the card's header fill.
	assertEquals(shape(bodyOf(graph, 'a.html', 'page')), ['call:card']);
	const card = callOf(graph, 'a.html', 'page');
	assertEquals([...card.fills.keys()].sort(), ['default', 'header']);
	assertEquals(shape(card.fills.get('header')!.items), ['call:chip']);
	assertEquals(card.fills.get('header')!.hasContent, true);
	assertEquals(shape(card.fills.get('default')!.items), []);
});

Deno.test("a call in a fill is still attributed to the partial that wrote it", async () => {
	const graph = await graphOf({
		'a.html': `<b-unwrap b-name="chip">[chip]</b-unwrap>
<button b-name="btn"><b-unwrap b-slot /></button>
<b-unwrap b-name="page"><div b-part="#btn"><b-unwrap b-part="#chip" /></div></b-unwrap>`,
	});
	const chip = graph.calls.find(c => c.partialName === 'chip')!;
	assertEquals(chip.fromPartial, 'page');
	assertEquals(chip.file, 'a.html');
});

Deno.test("callsIn flattens calls nested in fills", async () => {
	const graph = await graphOf({
		'a.html': `<b-unwrap b-name="chip">[chip]</b-unwrap>
<div b-name="card"><b-unwrap b-slot="header" /></div>
<div b-name="page"><b-unwrap b-part="#card"><b-unwrap b-in="header" b-part="#chip" /></b-unwrap></div>`,
	});
	assertEquals(callsIn(bodyOf(graph, 'a.html', 'page')).map(c => c.partialName), ['card', 'chip']);
});

Deno.test("calls carries every call site in depth-first source order", async () => {
	const graph = await graphOf({
		'a.html': `<b-unwrap b-name="chip">[chip]</b-unwrap>
<b-unwrap b-name="tail">[tail]</b-unwrap>
<div b-name="card"><b-unwrap b-slot="header" /></div>
<div b-name="page"><b-unwrap b-part="#card"><b-unwrap b-in="header" b-part="#chip" /></b-unwrap><b-unwrap b-part="#tail" /></div>`,
	});
	assertEquals(graph.calls.map(c => c.partialName), ['card', 'chip', 'tail']);
});

// --- resolution and reverse edges ---

Deno.test("callers holds one entry per call site and drives entry detection", async () => {
	const graph = await graphOf({
		'ui.html': `<button b-name="btn"><b-unwrap b-slot /></button>
<b-unwrap b-name="demo"><div b-part="#btn">a</div><div b-part="#btn">b</div></b-unwrap>`,
		'page.html': `<b-unwrap b-name="labeled"><b-unwrap b-part="ui.html#btn">x</b-unwrap></b-unwrap>`,
	});
	const btn = graph.nodes.get(partialKey('ui.html', 'btn'))!;
	assertEquals(btn.callers.length, 3);
	assertEquals(btn.callers.map(c => `${c.file}#${c.fromPartial}`), ['ui.html#demo', 'ui.html#demo', 'page.html#labeled']);
	assertEquals(btn.isEntry, false);
	assertEquals(graph.nodes.get(partialKey('ui.html', 'demo'))!.isEntry, true);
	assertEquals(graph.entries.includes(partialKey('ui.html', 'demo')), true);
	assertEquals(graph.entries.includes(partialKey('ui.html', 'btn')), false);
});

Deno.test("a call resolves to the file it names, not the file it is written in", async () => {
	const graph = await graphOf({
		'ui.html': `<b-unwrap b-name="label">[ui]</b-unwrap>`,
		'page.html': `<b-unwrap b-name="label">[page]</b-unwrap>
<b-unwrap b-name="uses"><b-unwrap b-part="ui.html#label" /></b-unwrap>`,
	});
	assertEquals(callOf(graph, 'page.html', 'uses').target, partialKey('ui.html', 'label'));
	assertEquals(graph.nodes.get(partialKey('page.html', 'label'))!.callers.length, 0);
});

Deno.test("an unresolved custom element call targets nothing", async () => {
	const graph = await graphOf({
		'a.html': `<b-unwrap b-name="uses"><my-widget>x</my-widget></b-unwrap>`,
	});
	const call = callOf(graph, 'a.html', 'uses');
	assertEquals(call.partialName, 'my-widget');
	assertEquals(call.target, null);
	assertEquals(graph.calls.length, 1);
});

Deno.test("referenced holds the roots a resolvable call targets", async () => {
	const { directory } = await compileFiles(new Map([
		['a.html', `<button b-name="btn"><b-unwrap b-slot /></button>
<b-unwrap b-name="demo"><div b-part="#btn">a</div></b-unwrap>`],
	]));
	const files: Map<string, CompiledFile> = directory.files;
	const graph = buildPartialGraph(files);
	const btn = files.get('a.html')!.partials.get('btn')!;
	const demo = files.get('a.html')!.partials.get('demo')!;
	assertEquals(graph.referenced.has(btn), true);
	assertEquals(graph.referenced.has(demo), false);
});

// --- cycles ---

Deno.test("partials reachable only through a cycle are unreached", async () => {
	const graph = await graphOf({
		'a.html': `<div b-name="ping"><b-unwrap b-part="#pong" /></div>
<div b-name="pong"><b-unwrap b-part="#ping" /></div>
<div b-name="lone">x</div>`,
	});
	assertEquals(graph.entries, [partialKey('a.html', 'lone')]);
	assertEquals(graph.unreached.sort(), [partialKey('a.html', 'ping'), partialKey('a.html', 'pong')].sort());
	assertEquals(graph.nodes.get(partialKey('a.html', 'lone'))!.isUnreached, false);
});

Deno.test("a partial an entry point reaches is not unreached, cycle or not", async () => {
	const graph = await graphOf({
		'a.html': `<div b-name="top"><b-unwrap b-part="#ping" /></div>
<div b-name="ping"><b-unwrap b-part="#pong" /></div>
<div b-name="pong"><b-unwrap b-part="#ping" /></div>`,
	});
	assertEquals(graph.entries, [partialKey('a.html', 'top')]);
	assertEquals(graph.unreached, []);
});

// --- bindings ---

Deno.test("a fill holding only whitespace is not content", async () => {
	const graph = await graphOf({
		'a.html': `<div b-name="card">H(<b-unwrap b-slot="header" />)B(<b-unwrap b-slot />)</div>
<div b-name="page">
	<b-unwrap b-part="#card">
		<b-unwrap b-in="header">real</b-unwrap>
	</b-unwrap>
</div>`,
	});
	const card = callOf(graph, 'a.html', 'page');
	assertEquals(card.fills.get('header')!.hasContent, true);
	// The newlines and tabs around the b-in tag are indentation, not a fill.
	assertEquals(card.fills.get('default')!.hasContent, false);
});

Deno.test("a call records the data bindings written on it", async () => {
	const graph = await graphOf({
		'a.html': `<b-unwrap b-name="label">{{ text }}{{ tone }}</b-unwrap>
<b-unwrap b-name="uses"><b-unwrap b-part="#label" b-data:text="msg" b-data:tone="'loud'" /></b-unwrap>`,
	});
	assertEquals(callOf(graph, 'a.html', 'uses').dataBindings, ['text', 'tone']);
});
