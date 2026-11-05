/**
 * End-to-end tests for reactive `b-for`: build a project with the real CLI, render the
 * page with the JS and PHP runtimes, then run the generated module, the store file and
 * the runtime against that HTML in jsdom.
 *
 * Like `dom_patch_generate_test.ts`, this file must not import the compiler (jsdom
 * and the compiler's parse5 cannot load together); the build runs in a subprocess.
 */

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { JSDOM } from "npm:jsdom";

import { renderRoot, type RootRNode } from "../runtime/js/render.ts";
import { linkAsScript } from "./link-as-script.ts";

const TMPDIR = "/tmp/claude-1000/dom-patch-for";
const CLI_PATH = new URL("../cli.ts", import.meta.url).pathname;
const RENDER_PHP = new URL("../runtime/php/render.php", import.meta.url).pathname;

// Let the microtask that patches the DOM after a change run.
const settled = () => new Promise(resolve => setTimeout(resolve));

const STORE_JS = (name: string) => `import { BackflipStore } from '/static/bfdom/runtime/dom-patch/stores.js';
export default new BackflipStore('${name}');
`;

async function buildProject(appHtml: string, storeNames: string[] = ["items"]): Promise<string> {
	const workDir = path.join(TMPDIR, `p_${Date.now()}_${Math.random().toString(36).slice(2)}`);
	for (const dir of ["templates", "static/stores", "static/bfdom"]) await fs.mkdir(path.join(workDir, dir), { recursive: true });
	await fs.writeFile(path.join(workDir, "templates", "app.html"), appHtml);
	for (const name of storeNames) await fs.writeFile(path.join(workDir, "static", "stores", `${name}.js`), STORE_JS(name));
	await fs.writeFile(path.join(workDir, "backflip.json"), JSON.stringify({
		root: "templates",
		output: [{ lang: "dom-patch", path: "static/bfdom" }, { lang: "js", path: "dist" }, { lang: "php", path: "php" }],
		assets: [{ name: "static", path: "static", prefix: "/static/" }],
		stores: "static/stores",
	}));
	const out = await new Deno.Command("deno", {
		args: ["run", "--allow-read", "--allow-write", CLI_PATH],
		cwd: workDir, stdout: "piped", stderr: "piped",
	}).output();
	const stderr = new TextDecoder().decode(out.stderr);
	assertEquals(out.code, 0, `cli failed: ${stderr}`);
	assertEquals(stderr.includes("warning:"), false, `unexpected warning: ${stderr}`);
	return workDir;
}

async function renderJs(workDir: string, stores: Record<string, unknown>): Promise<string> {
	const mod = await import(path.join(workDir, "dist", "app.js"));
	return renderRoot(mod.page as RootRNode, {}, undefined, stores);
}

async function renderPhp(workDir: string, stores: Record<string, unknown>): Promise<string> {
	const harnessPath = path.join(workDir, "harness.php");
	await fs.writeFile(harnessPath, `<?php
require '${RENDER_PHP}';
$partials = require '${path.join(workDir, "php", "app.php")}';
$stores = json_decode(${JSON.stringify(JSON.stringify(stores))}, true);
echo backflip_renderRoot($partials['page'], [], [], $stores);
`);
	const out = await new Deno.Command("php", { args: [harnessPath], stdout: "piped", stderr: "piped" }).output();
	const stderr = new TextDecoder().decode(out.stderr);
	if (out.code !== 0) throw new Error(`php failed (${out.code}): ${stderr}`);
	return new TextDecoder().decode(out.stdout);
}

const RUNTIMES = { js: renderJs, php: renderPhp };

// A store as generated code sees it.
interface Store {
	data: unknown;
	set(data: unknown): void;
	setAt(path: (string | number)[], value: unknown): void;
}

// The server-rendered HTML in a window, parsed but not yet patched. `start` runs the
// generated module against it.
async function pageFor(workDir: string, html: string, tagName: string) {
	const src = await linkAsScript(path.join(workDir, "static/bfdom", `${tagName}.js`), { "/static/": path.join(workDir, "static") });
	const dom = new JSDOM(`<!DOCTYPE html>${html}`, { runScripts: "outside-only" });
	await new Promise(resolve => dom.window.addEventListener("load", resolve, { once: true }));
	const doc = dom.window.document;
	const el = doc.querySelector(tagName)!;
	return {
		doc, el,
		start: () => dom.window.eval(src),
		// Values go in as the window's own objects: a store accepts only plain objects of its realm.
		store: (name = "items"): Store => {
			const store = (el as unknown as { bfPatch: { constructor: { bfStores: Record<string, Store> } } }).bfPatch.constructor.bfStores[name];
			const own = (v: unknown) => dom.window.JSON.parse(JSON.stringify(v));
			return {
				data: store.data,
				set: data => store.set(own(data)),
				setAt: (at, value) => store.setAt(own(at), own(value)),
			};
		},
		// What the element shows: no markers, no data-bfids, whitespace collapsed.
		content: (of: Element = el) => of.innerHTML
			.replace(/<!--[^>]*-->/g, "").replace(/ data-bfid="[^"]*"/g, "").replace(/\s+/g, " ").replace(/> </g, "><").trim(),
	};
}

// Run `test` against the page each runtime renders, from one build.
function bothRuntimes(
	name: string,
	appHtml: string,
	stores: Record<string, unknown>,
	tagName: string,
	test: (page: Awaited<ReturnType<typeof pageFor>>, html: string) => Promise<void>,
): void {
	Deno.test(name, async () => {
		const workDir = await buildProject(appHtml, Object.keys(stores));
		try {
			for (const render of Object.values(RUNTIMES)) {
				const html = await render(workDir, stores);
				await test(await pageFor(workDir, html, tagName), html);
			}
		} finally {
			await fs.rm(workDir, { recursive: true, force: true });
		}
	});
}

const FRESH = <T>(v: T): T => JSON.parse(JSON.stringify(v));

// --- a list ---

const LIST_HTML = `<my-list b-store:items b-attr:suffix b-generate="full">
	<ul>
		<li>head</li>
		<li b-for="w, i in items.data.list" b-key="w.id" :data-id="w.id" :class="i == 0 ? 'first' : 'rest'">{{ w.name }}{{ suffix }}</li>
		<li>tail</li>
	</ul>
</my-list>

<b-unwrap b-name="page" b-export>
	<body><my-list suffix="!"></my-list></body>
</b-unwrap>`;

const A = { id: 1, name: "a" }, B = { id: 2, name: "b" }, C = { id: 3, name: "c" };
const LIST = (...xs: unknown[]) => ({ list: xs });
const row = (id: number, cls: string, text: string) => `<li data-id="${id}" class="${cls}">${text}</li>`;
const shown = (...rows: string[]) => `<ul><li>head</li>${rows.join("")}<li>tail</li></ul>`;

Deno.test("b-for: JS and PHP render the same markers", async () => {
	const workDir = await buildProject(LIST_HTML);
	try {
		const stores = { items: LIST(A, B) };
		const strip = (html: string) => html.replace(/<script type="application\/json".*?<\/script>/, "");
		assertEquals(strip(await renderPhp(workDir, stores)), strip(await renderJs(workDir, stores)));
	} finally {
		await fs.rm(workDir, { recursive: true, force: true });
	}
});

bothRuntimes("b-for: the module patches nothing at init, and items keep their nodes", LIST_HTML, { items: LIST(A, B) }, "my-list", async ({ el, start, content }, html) => {
	assertStringIncludes(html, `data-bf-store="items"`);
	assertStringIncludes(html, `<link rel="modulepreload" href="/static/stores/items.js">`);
	const before = [...el.querySelectorAll("li")];
	const markup = el.innerHTML;
	start();
	await settled();
	assertEquals(el.innerHTML, markup);
	assertEquals([...el.querySelectorAll("li")], before);
	assertEquals(content(), shown(row(1, "first", "a!"), row(2, "rest", "b!")));
});

bothRuntimes("b-for: changed items update in place", LIST_HTML, { items: LIST(A, B) }, "my-list", async ({ el, start, store, content }) => {
	start();
	const before = [...el.querySelectorAll("li")];
	store().setAt(["list", 1, "name"], "B");
	await settled();
	assertEquals(content(), shown(row(1, "first", "a!"), row(2, "rest", "B!")));
	assertEquals([...el.querySelectorAll("li")], before);
});

bothRuntimes("b-for: an attribute change reaches every item", LIST_HTML, { items: LIST(A, B) }, "my-list", async ({ el, start, content }) => {
	start();
	el.setAttribute("suffix", "?");
	await settled();
	assertEquals(content(), shown(row(1, "first", "a?"), row(2, "rest", "b?")));
});

bothRuntimes("b-for: items are added, removed and moved by key, even when the data is all new objects", LIST_HTML, { items: LIST(A, B) }, "my-list", async ({ el, start, store, content }) => {
	start();
	const [, a, b] = el.querySelectorAll("li");

	// A response replaces the whole list with objects equal to the old ones, plus one.
	store().set(FRESH(LIST(C, B, A)));
	await settled();
	assertEquals(content(), shown(row(3, "first", "c!"), row(2, "rest", "b!"), row(1, "rest", "a!")));
	const lis = el.querySelectorAll("li");
	assertEquals([lis[2], lis[3]], [b, a]);

	// An added item patches like the rest.
	store().setAt(["list", 0, "name"], "C");
	await settled();
	assertEquals(content(), shown(row(3, "first", "C!"), row(2, "rest", "b!"), row(1, "rest", "a!")));

	store().set(FRESH(LIST(A)));
	await settled();
	assertEquals(content(), shown(row(1, "first", "a!")));
	assertEquals(el.querySelectorAll("li")[1], a);

	store().set(LIST());
	await settled();
	assertEquals(content(), shown());

	store().set(FRESH(LIST(B)));
	await settled();
	assertEquals(content(), shown(row(2, "first", "b!")));
});

bothRuntimes("b-for: an empty list renders nothing, and items can arrive later", LIST_HTML, { items: LIST() }, "my-list", async ({ start, store, content }) => {
	start();
	assertEquals(content(), shown());
	store().set(LIST(A, B));
	await settled();
	assertEquals(content(), shown(row(1, "first", "a!"), row(2, "rest", "b!")));
});

// --- two elements ---

const TWO_HTML = LIST_HTML.replace(`<my-list suffix="!"></my-list>`, `<my-list id="one" suffix="!"></my-list><my-list id="two" suffix="?"></my-list>`);

bothRuntimes("b-for: each instance of a partial keeps its own items", TWO_HTML, { items: LIST(A) }, "my-list", async ({ doc, start, store, content }) => {
	start();
	store().set(LIST(A, B));
	await settled();
	assertEquals(content(doc.querySelector("#one")!), shown(row(1, "first", "a!"), row(2, "rest", "b!")));
	assertEquals(content(doc.querySelector("#two")!), shown(row(1, "first", "a?"), row(2, "rest", "b?")));
});

const SLOT_HTML = `<my-panel b-store:items b-attr:t b-generate="full">
	<div><b-unwrap b-slot /></div>
	<ul><li b-for="w in items.data.list" b-key="w.id">{{ w.name }}{{ t }}</li></ul>
</my-panel>

<b-unwrap b-name="page" b-export>
	<body><my-panel id="outer" t="o"><my-panel id="inner" t="i">x</my-panel></my-panel></body>
</b-unwrap>`;

bothRuntimes("b-for: an instance nested through a slot keeps its own items", SLOT_HTML, { items: LIST(A) }, "my-panel", async ({ doc, start, store }) => {
	const errors = await capturingErrors(async () => {
		start();
		store().set(LIST(B, A));
		await settled();
		(doc.querySelector("#outer") as Element).setAttribute("t", "O");
		await settled();
	});
	assertEquals(errors, []);
	const items = (id: string) => [...doc.querySelectorAll(`#${id} > ul > li`)].map(li => li.textContent);
	assertEquals(items("outer"), ["bO", "aO"]);
	assertEquals(items("inner"), ["bi", "ai"]);
});

// --- item shapes ---

const MULTI_HTML = `<my-multi b-store:items b-generate="full">
	<dl><b-unwrap b-for="w in items.data.list" b-key="w.id">
		<dt>{{ w.name }}</dt>
		{{ w.name }}-text
		<dd :title="w.name">x</dd>
	</b-unwrap></dl>
</my-multi>

<b-unwrap b-name="page" b-export>
	<body><my-multi></my-multi></body>
</b-unwrap>`;

const multi = (...names: string[]) => `<dl>${names.map(n => `<dt>${n}</dt> ${n}-text <dd title="${n}">x</dd>`).join(" ")}</dl>`.replace(/<\/dd> <dt>/g, "</dd><dt>");

bothRuntimes("b-for: a multi-root item with text and whitespace adds, removes, moves and updates as one", MULTI_HTML, { items: LIST(A, B) }, "my-multi", async ({ el, start, store, content }) => {
	start();
	const [dtA] = el.querySelectorAll("dt");

	store().set(FRESH(LIST(B, C, { id: 1, name: "A" })));
	await settled();
	assertEquals(content(), multi("b", "c", "A"));
	assertEquals(el.querySelectorAll("dt")[2], dtA);

	store().set(FRESH(LIST(C)));
	await settled();
	assertEquals(content(), multi("c"));
});

const TEXT_HTML = `<my-text b-store:items b-generate="full"><p><b-unwrap b-for="w in items.data.list" b-key="w.id">[{{ w.name }}]</b-unwrap></p></my-text>

<b-unwrap b-name="page" b-export>
	<body><my-text></my-text></body>
</b-unwrap>`;

bothRuntimes("b-for: a text-only item, with no element at all, works", TEXT_HTML, { items: LIST(A, B) }, "my-text", async ({ start, store, content }) => {
	const errors = await capturingErrors(async () => {
		start();
		store().set(LIST(B, { id: 1, name: "A" }, C));
		await settled();
	});
	assertEquals(errors, []);
	assertEquals(content(), "<p>[b][A][c]</p>");
});

const OPTIONAL_HTML = `<my-opt b-store:items b-generate="full"><ul><b-unwrap b-for="w in items.data.list" b-key="w.id"><li b-if="w.on">{{ w.name }}</li></b-unwrap></ul></my-opt>

<b-unwrap b-name="page" b-export>
	<body><my-opt></my-opt></body>
</b-unwrap>`;

const OFF = { id: 1, name: "a", on: false }, ON = { id: 2, name: "b", on: true };

bothRuntimes("b-for: an item that renders nothing still holds its place", OPTIONAL_HTML, { items: LIST(OFF, ON) }, "my-opt", async ({ start, store, content }) => {
	const errors = await capturingErrors(async () => {
		start();
		assertEquals(content(), "<ul><li>b</li></ul>");
		store().setAt(["list", 0, "on"], true);
		await settled();
		assertEquals(content(), "<ul><li>a</li><li>b</li></ul>");
		store().set(FRESH(LIST(ON, { ...OFF, on: true })));
		await settled();
		assertEquals(content(), "<ul><li>b</li><li>a</li></ul>");
	});
	assertEquals(errors, []);
});

const TABLE_HTML = `<my-table b-store:items b-generate="full"><table><tbody><tr b-for="w in items.data.list" b-key="w.id"><td>{{ w.name }}</td></tr></tbody></table></my-table>

<b-unwrap b-name="page" b-export>
	<body><my-table></my-table></body>
</b-unwrap>`;

bothRuntimes("b-for: an added row is parsed in its table", TABLE_HTML, { items: LIST(A) }, "my-table", async ({ start, store, content }) => {
	start();
	store().set(LIST(A, B));
	await settled();
	assertEquals(content(), "<table><tbody><tr><td>a</td></tr><tr><td>b</td></tr></tbody></table>");
});

const NO_TBODY_HTML = `<my-bare b-store:items b-generate="full"><table><tr b-for="w in items.data.list" b-key="w.id"><td>{{ w.name }}</td></tr></table></my-bare>

<b-unwrap b-name="page" b-export>
	<body><my-bare></my-bare></body>
</b-unwrap>`;

bothRuntimes("b-for: a row directly under a table is reported and not updated, since the parser's tbody splits the markers", NO_TBODY_HTML, { items: LIST(A) }, "my-bare", async ({ start, store, content }) => {
	const errors = await capturingErrors(async () => {
		start();
		store().set(LIST(B));
		await settled();
	});
	assertEquals(errors.length > 0, true);
	assertStringIncludes(String(errors[0][0]), "comment markers");
	assertEquals(content(), "<table><tbody><tr><td>a</td></tr></tbody></table>");
});

// --- nesting ---

const NESTED_HTML = `<my-grid b-store:items b-generate="full">
	<section b-for="r in items.data.list" b-key="r.id">
		<h3>{{ r.title }}</h3>
		<i b-for="c in r.cells" b-key="c.id">{{ c.name }}{{ r.title }}</i>
	</section>
</my-grid>

<b-unwrap b-name="page" b-export>
	<body><my-grid></my-grid></body>
</b-unwrap>`;

const R1 = { id: 1, title: "x", cells: [A, B] }, R2 = { id: 2, title: "y", cells: [A] };
const section = (t: string, ...cells: string[]) => `<section><h3>${t}</h3>${cells.map(c => `<i>${c}${t}</i>`).join("")}</section>`;

bothRuntimes("b-for: a loop in a loop keeps inner items within their outer item", NESTED_HTML, { items: LIST(R1, R2) }, "my-grid", async ({ el, start, store, content }) => {
	const errors = await capturingErrors(async () => {
		start();
		const [first] = el.querySelectorAll("section");
		const firstCell = first.querySelector("i");
		assertEquals(content(), section("x", "a", "b") + section("y", "a"));

		// Same inner keys in different outer items; each changes alone.
		store().setAt(["list", 1, "cells"], [B, A, C]);
		await settled();
		assertEquals(content(), section("x", "a", "b") + section("y", "b", "a", "c"));

		// A moved outer item keeps its inner nodes and keeps patching.
		store().set(FRESH(LIST({ ...R2, cells: [C] }, { ...R1, title: "z" })));
		await settled();
		assertEquals(content(), section("y", "c") + section("z", "a", "b"));
		assertEquals(el.querySelectorAll("section")[1], first);
		assertEquals(first.querySelector("i"), firstCell);

		// An added outer item renders its inner loop, which then patches.
		store().set(LIST({ id: 3, title: "n", cells: [A] }));
		await settled();
		store().setAt(["list", 0, "cells"], [B, A]);
		await settled();
		assertEquals(content(), section("n", "b", "a"));
	});
	assertEquals(errors, []);
});

const IN_SET_HTML = `<my-maybe b-store:items b-generate="full">
	<div b-if="items.data.open"><p b-for="w in items.data.list" b-key="w.id">{{ w.name }}</p></div>
	<em b-else>closed</em>
</my-maybe>

<b-unwrap b-name="page" b-export>
	<body><my-maybe></my-maybe></body>
</b-unwrap>`;

bothRuntimes("b-for: a loop in a b-if branch patches, also once the branch is rendered in the browser", IN_SET_HTML, { items: { open: false, list: [A] } }, "my-maybe", async ({ start, store, content }) => {
	const errors = await capturingErrors(async () => {
		start();
		assertEquals(content(), "<em>closed</em>");
		store().set({ open: true, list: [A] });
		await settled();
		assertEquals(content(), "<div><p>a</p></div>");
		store().set({ open: true, list: [B, A] });
		await settled();
		assertEquals(content(), "<div><p>b</p><p>a</p></div>");
		store().set({ open: false, list: [B, A] });
		await settled();
		assertEquals(content(), "<em>closed</em>");
		store().set({ open: true, list: [C] });
		await settled();
		assertEquals(content(), "<div><p>c</p></div>");
	});
	assertEquals(errors, []);
});

bothRuntimes("b-for: a loop in a server-rendered b-if branch pairs its items at init", IN_SET_HTML, { items: { open: true, list: [A, B] } }, "my-maybe", async ({ el, start, store, content }) => {
	start();
	const [a] = el.querySelectorAll("p");
	store().set({ open: true, list: [B, A] });
	await settled();
	assertEquals(content(), "<div><p>b</p><p>a</p></div>");
	assertEquals(el.querySelectorAll("p")[1], a);
});

const SET_IN_ITEM_HTML = `<my-flags b-store:items b-generate="full">
	<div b-for="w in items.data.list" b-key="w.id"><b b-if="w.on">{{ w.name }} on</b><i b-else>{{ w.name }} off</i></div>
</my-flags>

<b-unwrap b-name="page" b-export>
	<body><my-flags></my-flags></body>
</b-unwrap>`;

bothRuntimes("b-for: a b-if in an item swaps and patches within that item, and survives a move", SET_IN_ITEM_HTML, { items: LIST(OFF, ON) }, "my-flags", async ({ start, store, content }) => {
	const errors = await capturingErrors(async () => {
		start();
		assertEquals(content(), "<div><i>a off</i></div><div><b>b on</b></div>");
		store().setAt(["list", 0, "on"], true);
		await settled();
		assertEquals(content(), "<div><b>a on</b></div><div><b>b on</b></div>");
		store().set(FRESH(LIST({ ...ON, on: false }, { ...OFF, on: true, name: "A" })));
		await settled();
		assertEquals(content(), "<div><i>b off</i></div><div><b>A on</b></div>");
	});
	assertEquals(errors, []);
});

// --- what stays static, and what is reported ---

const STATIC_HTML = `<my-kid b-attr:v b-generate="full"><u>{{ v }}</u></my-kid>

<my-static b-store:items b-attr:t b-generate="full">
	<p>{{ t }}</p>
	<my-kid b-for="w in items.data.list" b-key="w.id" :v="w.name"></my-kid>
</my-static>

<b-unwrap b-name="page" b-export>
	<body><my-static t="1"></my-static></body>
</b-unwrap>`;

bothRuntimes("b-for: a loop holding a custom element is not patched, and its store is not shipped for it", STATIC_HTML, { items: LIST(A, B) }, "my-static", async ({ el, start, content }, html) => {
	assertEquals(html.includes(`data-bf-store="items"`), false);
	start();
	assertEquals(content().includes("<u>a</u>"), true);
	el.setAttribute("t", "2");
	await settled();
	assertStringIncludes(content(), "<p>2</p>");
	assertEquals(el.querySelectorAll("my-kid").length, 2);
});

bothRuntimes("b-for: duplicate keys in the rendered data are reported, and the list stays as rendered", LIST_HTML, { items: LIST(A, { ...B, id: 1 }) }, "my-list", async ({ start, store, content }) => {
	const errors = await capturingErrors(async () => {
		start();
		store().set(LIST(B));
		await settled();
	});
	assertEquals(errors.length, 1);
	assertStringIncludes(String(errors[0][1]), "not unique");
	assertEquals(content(), shown(row(1, "first", "a!"), row(1, "rest", "b!")));
});

Deno.test("b-for: a PHP array with non-sequential keys renders, and is reported as not an array in the browser", async () => {
	const workDir = await buildProject(LIST_HTML);
	try {
		const html = await renderPhp(workDir, { items: { list: { "42": A, "7": B } } });
		const { start, content } = await pageFor(workDir, html, "my-list");
		const errors = await capturingErrors(async () => {
			start();
			await settled();
		});
		assertEquals(errors.length, 1);
		assertStringIncludes(String(errors[0][1]), "only an array can be patched");
		assertEquals(content(), shown(row(2, "first", "b!"), row(1, "rest", "a!")));
	} finally {
		await fs.rm(workDir, { recursive: true, force: true });
	}
});

async function capturingErrors(f: () => Promise<void>): Promise<unknown[][]> {
	const errors: unknown[][] = [];
	const orig = console.error;
	console.error = (...args: unknown[]) => { errors.push(args); };
	try {
		await f();
	} finally {
		console.error = orig;
	}
	return errors;
}
