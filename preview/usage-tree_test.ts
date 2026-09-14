import { assertEquals, assertStringIncludes } from "@std/assert";
import { compileFiles } from "../compiler/partials.ts";
import { parseUsageView, renderUsageTree, type UsageView } from "./usage-tree.ts";
import type { CompiledFile } from "../compiler/types.ts";

async function compile(sources: { [file: string]: string }): Promise<Map<string, CompiledFile>> {
	const { directory } = await compileFiles(new Map(Object.entries(sources)));
	return directory.files;
}

/**
 * The drawn tree as indented rows — the page's `<ul>` / `<li>` nesting with the
 * markup taken off, so a test can assert what sits under what.
 */
function outline(html: string): string[] {
	const rows: string[] = [];
	let depth = -1;
	let pending: { depth: number; text: string } | null = null;
	const flush = () => {
		if (!pending) return;
		const text = pending.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
		if (text) rows.push('  '.repeat(pending.depth) + text);
		pending = null;
	};
	for (const part of html.split(/(<\/?ul[^>]*>|<li[^>]*>|<\/li>)/)) {
		if (part.startsWith('<ul')) { flush(); depth++; }
		else if (part.startsWith('</ul')) { flush(); depth--; }
		else if (part.startsWith('<li')) { flush(); pending = { depth, text: '' }; }
		else if (part.startsWith('</li')) flush();
		else if (pending) pending.text += part;
	}
	return rows;
}

async function draw(sources: { [file: string]: string }, file: string, name: string, view: UsageView): Promise<string[]> {
	return outline(renderUsageTree(await compile(sources), file, name, { view }));
}

// A card with two slots, a chip to put in them, and a page that calls the card.
const SLOTS = {
	'ui.html': `<b-unwrap b-name="chip">[chip]</b-unwrap>
<div b-name="card">H(<b-unwrap b-slot="header" />)B(<b-unwrap b-slot />)</div>
<div b-name="page"><b-unwrap b-part="#card"><b-unwrap b-in="header" b-part="#chip" />body</b-unwrap></div>`,
};

// --- callees ---

Deno.test("callees draws a call under the slot it fills", async () => {
	assertEquals(await draw(SLOTS, 'ui.html', 'page', 'callees'), [
		'page ui.html 0 refs this partial preview',
		'  card 1 ref preview',
		'    slot "header"',
		'      chip 1 ref preview',
		'    slot "default" filled with markup',
	]);
});

Deno.test("callees marks a slot no call fills as unfilled", async () => {
	const rows = await draw(SLOTS, 'ui.html', 'card', 'callees');
	assertEquals(rows, [
		'card ui.html 1 ref this partial preview',
		'  slot "header" unfilled',
		'  slot "default" unfilled',
	]);
});

Deno.test("callees expands every occurrence of a repeated partial", async () => {
	const rows = await draw({
		'a.html': `<b-unwrap b-name="icon">i</b-unwrap>
<div b-name="leaf"><b-unwrap b-part="#icon" /></div>
<div b-name="top"><b-unwrap b-part="#leaf" /><b-unwrap b-part="#leaf" /></div>`,
	}, 'a.html', 'top', 'callees');
	assertEquals(rows, [
		'top a.html 0 refs this partial preview',
		'  leaf 2 refs preview',
		'    icon 1 ref preview',
		'  leaf 2 refs preview',
		'    icon 1 ref preview',
	]);
});

Deno.test("callees stops where a call re-enters a partial already being drawn", async () => {
	const rows = await draw({
		'a.html': `<div b-name="ping"><b-unwrap b-part="#pong" /></div>
<div b-name="pong"><b-unwrap b-part="#ping" /></div>`,
	}, 'a.html', 'ping', 'callees');
	assertEquals(rows, [
		'ping a.html 1 ref this partial preview',
		'  pong 1 ref preview',
		'    ping 1 ref this partial cycle — expanded above preview',
	]);
});

Deno.test("callees resolves a b-slot written inside a fill against the caller's fill", async () => {
	// top fills middle's "outer"; middle forwards it into target's "inner".
	const rows = await draw({
		'a.html': `<b-unwrap b-name="chip">[chip]</b-unwrap>
<div b-name="target">[<b-unwrap b-slot="inner" />]</div>
<div b-name="middle"><b-unwrap b-part="#target"><b-unwrap b-in="inner" b-slot="outer" /></b-unwrap></div>
<div b-name="top"><b-unwrap b-part="#middle"><b-unwrap b-in="outer" b-part="#chip" /></b-unwrap></div>`,
	}, 'a.html', 'top', 'callees');
	assertEquals(rows, [
		'top a.html 0 refs this partial preview',
		'  middle 1 ref preview',
		'    target 1 ref preview',
		'      slot "inner"',
		'        slot "outer"',
		'          chip 1 ref preview',
	]);
});

Deno.test("callees draws a fill that names no declared slot apart from the body", async () => {
	const rows = await draw({
		'a.html': `<b-unwrap b-name="chip">[chip]</b-unwrap>
<div b-name="card">H(<b-unwrap b-slot="header" />)</div>
<div b-name="page"><b-unwrap b-part="#card"><b-unwrap b-in="nope" b-part="#chip" /></b-unwrap></div>`,
	}, 'a.html', 'page', 'callees');
	assertEquals(rows, [
		'page a.html 0 refs this partial preview',
		'  card 1 ref preview',
		'    slot "header" unfilled',
		'    slot "nope" no matching b-slot in card',
		'      chip 1 ref preview',
	]);
});

Deno.test("callees draws a call with no definition as unresolved", async () => {
	const rows = await draw({
		'a.html': `<b-unwrap b-name="uses"><my-widget>x</my-widget></b-unwrap>`,
	}, 'a.html', 'uses', 'callees');
	assertEquals(rows, [
		'uses a.html 0 refs this partial preview',
		'  my-widget unresolved — nothing defines my-widget',
	]);
});

// --- callers ---

Deno.test("callers lists one row per call site and marks entry points", async () => {
	const rows = await draw({
		'ui.html': `<button b-name="btn"><b-unwrap b-slot /></button>
<b-unwrap b-name="demo"><div b-part="#btn">a</div><div b-part="#btn">b</div></b-unwrap>`,
	}, 'ui.html', 'btn', 'callers');
	assertEquals(rows, [
		'btn ui.html 2 refs this partial preview',
		'  demo ui.html 0 refs entry fills default preview',
		'  demo ui.html 0 refs entry fills default preview',
	]);
});

Deno.test("callers walks up to the partial nothing calls", async () => {
	const rows = await draw({
		'a.html': `<div b-name="leaf">x</div>
<div b-name="mid"><b-unwrap b-part="#leaf" /></div>
<div b-name="top"><b-unwrap b-part="#mid" /></div>`,
	}, 'a.html', 'leaf', 'callers');
	assertEquals(rows, [
		'leaf a.html 1 ref this partial preview',
		'  mid a.html 1 ref preview',
		'    top a.html 0 refs entry preview',
	]);
});

Deno.test("callers stops where the chain re-enters a partial", async () => {
	const rows = await draw({
		'a.html': `<div b-name="ping"><b-unwrap b-part="#pong" /></div>
<div b-name="pong"><b-unwrap b-part="#ping" /></div>`,
	}, 'a.html', 'ping', 'callers');
	assertEquals(rows, [
		'ping a.html 1 ref this partial preview',
		'  pong a.html 1 ref preview',
		'    ping a.html 1 ref this partial cycle — expanded above preview',
	]);
});

// --- whole trees ---

Deno.test("trees draws only the trees that reach the partial, from their roots", async () => {
	const sources = {
		'a.html': `<div b-name="leaf">x</div>
<div b-name="one"><b-unwrap b-part="#leaf" /></div>
<div b-name="two"><b-unwrap b-part="#leaf" /></div>
<div b-name="elsewhere">nothing to do with it</div>`,
	};
	const rows = await draw(sources, 'a.html', 'leaf', 'trees');
	assertEquals(rows, [
		'one a.html 0 refs preview',
		'  leaf 2 refs this partial preview',
		'two a.html 0 refs preview',
		'  leaf 2 refs this partial preview',
	]);
	const html = renderUsageTree(await compile(sources), 'a.html', 'leaf', { view: 'trees' });
	assertStringIncludes(html, '2 of 3 trees in this project reach it.');
});

Deno.test("trees reaches a partial only called from a cycle", async () => {
	const sources = {
		'a.html': `<div b-name="ping"><b-unwrap b-part="#pong" /></div>
<div b-name="pong"><b-unwrap b-part="#ping" /></div>`,
	};
	const html = renderUsageTree(await compile(sources), 'a.html', 'ping', { view: 'trees' });
	assertStringIncludes(html, 'only reachable through a cycle');
	assertEquals(outline(html)[0], 'ping a.html 1 ref this partial preview');
});

Deno.test("trees says so when no tree reaches the partial", async () => {
	// Nothing to draw: a partial nothing calls is a tree of its own, so this can
	// only happen when the partial does not exist.
	const html = renderUsageTree(await compile({ 'a.html': `<div b-name="x">x</div>` }), 'a.html', 'nope', { view: 'trees' });
	assertStringIncludes(html, 'No partial <code>nope</code> in a.html.');
});

// --- links and chrome ---

Deno.test("every node links to its own usage tree and its preview", async () => {
	const html = renderUsageTree(await compile(SLOTS), 'ui.html', 'page', { view: 'callees' });
	assertStringIncludes(html, 'href="/__usage/ui.html/chip"');
	assertStringIncludes(html, 'href="/preview/ui.html/chip"');
	assertStringIncludes(html, 'href="/__usage/ui.html/card"');
});

Deno.test("the page offers all three views, marking the current one", async () => {
	const html = renderUsageTree(await compile(SLOTS), 'ui.html', 'page', { view: 'callers' });
	assertStringIncludes(html, 'href="/__usage/ui.html/page?view=trees"');
	assertStringIncludes(html, 'class="on" href="/__usage/ui.html/page?view=callers"');
	assertStringIncludes(html, 'href="/__usage/ui.html/page?view=callees"');
});

Deno.test("names are escaped, not interpolated", async () => {
	const html = renderUsageTree(await compile(SLOTS), 'ui.html', '<script>', { view: 'trees' });
	assertStringIncludes(html, '&lt;script&gt;');
	assertEquals(html.includes('<code><script></code>'), false);
});

Deno.test("parseUsageView falls back to whole trees", () => {
	assertEquals(parseUsageView('callers'), 'callers');
	assertEquals(parseUsageView('callees'), 'callees');
	assertEquals(parseUsageView('trees'), 'trees');
	assertEquals(parseUsageView('nonsense'), 'trees');
	assertEquals(parseUsageView(null), 'trees');
});
