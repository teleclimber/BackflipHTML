/**
 * End-to-end test for `b-generate="full"`: build a project with the real CLI, render
 * the page with the JS runtime, then run the generated module against that HTML in a
 * browser (jsdom) and check the element registers itself and patches.
 *
 * Like `compiler/generate/dom-patch/exec_test.ts`, this file must not import the
 * compiler: jsdom needs parse5 as CommonJS while the compiler imports it as an ES
 * module, and loading both in one Deno test triggers a require()-cycle error. The
 * build therefore runs in a CLI subprocess and only its output is imported here.
 */

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { JSDOM } from "npm:jsdom";

import { renderRoot, type RootRNode } from "../runtime/js/render.ts";
import { linkAsScript } from "./link-as-script.ts";

const TMPDIR = "/tmp/claude-1000/dom-patch-generate";
const CLI_PATH = new URL("../cli.ts", import.meta.url).pathname;

// Let the microtask that patches the DOM after a change run.
const settled = () => new Promise(resolve => setTimeout(resolve));

// A `full` partial exercising all three patch flavors: a dynamic attribute, a print,
// and a reactive b-if set.
const APP_HTML = `<count-badge b-attr:count b-attr:urgent.bool b-generate="full">
	<span :data-count="count">{{ count }}</span>
	<em b-if="urgent">Hurry</em>
	<em b-else>Relax</em>
</count-badge>

<b-unwrap b-name="page" b-export>
	<body><count-badge count="5" urgent></count-badge></body>
</b-unwrap>`;

// Every site kind, each with a value the server omits the attribute for when `on` is false.
const OMITTED_ATTRS_HTML = `<plain-kid></plain-kid>

<attr-gone b-attr:on.bool b-attr:mode :data-root="on ? 'r' : null" b-generate="full">
	<i :title="on ? 'y' : null" :data-x="on ? 'y' : false"></i>
	<plain-kid :data-call="on ? 'y' : null"></plain-kid>
	<em b-if="mode == 'a'" :title="on ? 'a' : null">A</em>
	<em b-else :title="on ? 'b' : null">B</em>
</attr-gone>

<b-unwrap b-name="page" b-export>
	<body><attr-gone :on="false" mode="a"></attr-gone></body>
</b-unwrap>`;

const HYPHENATED_HTML = `<hy-badge b-attr:data-id b-attr:is-open.bool b-attr:count b-generate="full">
	<span :data-count="count">{{ count }}</span>
</hy-badge>

<b-unwrap b-name="page" b-export>
	<body><hy-badge data-id="3" is-open count="1"></hy-badge></body>
</b-unwrap>`;

const OMITTED_STRING_ATTR_HTML = `<str-kid b-attr:a b-generate="full"><b>[{{ a }}]</b></str-kid>

<b-unwrap b-name="page" b-export b-data:v>
	<body><str-kid :a="v"></str-kid></body>
</b-unwrap>`;

// The slot comes first, so the nested panel's elements precede the outer panel's own:
// a slot beside a reactive set, a set after the slot, a print, an attr and a call attr.
const NESTED_IN_SLOT_HTML = `<plain-kid></plain-kid>

<x-panel b-attr:t b-attr:open.bool b-generate="full">
	<header><b-unwrap b-slot /><p b-if="open"><b :title="t">{{ t }}</b></p><p b-else>closed</p></header>
	<section><i b-if="open">A</i><i b-else>B</i></section>
	<span :title="t">{{ t }}</span>
	<plain-kid :data-t="t"></plain-kid>
</x-panel>

<b-unwrap b-name="page" b-export>
	<body><x-panel id="outer" t="o" open><div><x-panel id="inner" t="i" open>x</x-panel></div></x-panel></body>
</b-unwrap>`;

// The tags match, but a <div> closes the <p>, and the parser reopens the <b> inside it
// as a copy that keeps its attributes.
const PARSER_COPY_HTML = `<x-copy b-attr:t b-generate="full">
	<p><b :title="t">a<div>b</div></b></p>
</x-copy>

<b-unwrap b-name="page" b-export>
	<body><x-copy t="a"></x-copy></body>
</b-unwrap>`;

async function buildProject(appHtml = APP_HTML): Promise<string> {
	const workDir = path.join(TMPDIR, `p_${Date.now()}_${Math.random().toString(36).slice(2)}`);
	await fs.mkdir(path.join(workDir, "templates"), { recursive: true });
	await fs.mkdir(path.join(workDir, "bfdom"), { recursive: true });
	await fs.writeFile(path.join(workDir, "templates", "app.html"), appHtml);
	await fs.writeFile(path.join(workDir, "backflip.json"), JSON.stringify({
		root: "templates",
		output: [{ lang: "dom-patch", path: "bfdom" }, { lang: "js", path: "dist" }],
		assets: [{ name: "bfdom", path: "bfdom", prefix: "/bfdom/" }],
	}));

	const cmd = new Deno.Command("deno", {
		args: ["run", "--allow-read", "--allow-write", CLI_PATH],
		cwd: workDir, stdout: "piped", stderr: "piped",
	});
	const out = await cmd.output();
	const stderr = new TextDecoder().decode(out.stderr);
	assertEquals(out.code, 0, `cli failed: ${stderr}`);
	assertEquals(stderr.includes("warning:"), false, `unexpected warning: ${stderr}`);
	return workDir;
}

/**
 * Put the server-rendered HTML in a window and run the generated module in it, linked
 * with the runtime files the build copied beside it — so the element base class
 * extends the window's HTMLElement. The document is fully parsed first, as it is for
 * the deferred module script the renderer injects.
 */
async function browserFor(workDir: string, html: string, tagName = "count-badge") {
	const src = await linkAsScript(path.join(workDir, "bfdom", `${tagName}.js`));
	const dom = new JSDOM(`<!DOCTYPE html>${html}`, { runScripts: "outside-only" });
	await new Promise(resolve => dom.window.addEventListener("load", resolve, { once: true }));
	dom.window.eval(src);
	return dom.window.document;
}

Deno.test("integration: attributes the server omits stay omitted in the browser, then follow their value", async () => {
	const workDir = await buildProject(OMITTED_ATTRS_HTML);
	try {
		const mod = await import(path.join(workDir, "dist", "app.js"));
		const html = renderRoot(mod.page as RootRNode, {});
		const doc = await browserFor(workDir, html, "attr-gone");
		const el = doc.querySelector("attr-gone")!;
		const values = () => ({
			root: el.getAttribute("data-root"),
			title: el.querySelector("i")!.getAttribute("title"),
			x: el.querySelector("i")!.getAttribute("data-x"),
			call: el.querySelector("plain-kid")!.getAttribute("data-call"),
			branch: el.querySelector("em")!.getAttribute("title"),
		});
		const absent = { root: null, title: null, x: null, call: null, branch: null };

		await settled();
		assertEquals(values(), absent);

		el.setAttribute("on", "");
		await settled();
		assertEquals(values(), { root: "r", title: "y", x: "y", call: "y", branch: "a" });

		el.removeAttribute("on");
		await settled();
		assertEquals(values(), absent);

		// A branch swapped in while the value is omitted renders without the attribute too.
		el.setAttribute("mode", "b");
		await settled();
		assertEquals(el.querySelector("em")!.textContent, "B");
		assertEquals(values(), absent);
	} finally {
		await fs.rm(workDir, { recursive: true, force: true });
	}
});

Deno.test("integration: a string b-attr whose attribute is omitted shows the same empty value on the server and in the browser", async () => {
	const workDir = await buildProject(OMITTED_STRING_ATTR_HTML);
	try {
		const mod = await import(path.join(workDir, "dist", "app.js"));
		for (const v of [null, undefined, false]) {
			const html = renderRoot(mod.page as RootRNode, { v });
			const server = new JSDOM(html).window.document.querySelector("str-kid")!;
			assertEquals(server.querySelector("b")!.textContent, "[]");

			const doc = await browserFor(workDir, html, "str-kid");
			await settled();
			const el = doc.querySelector("str-kid")!;
			assertEquals(el.hasAttribute("a"), false);
			assertEquals(el.querySelector("b")!.textContent, "[]");

			el.setAttribute("a", "x");
			await settled();
			assertEquals(el.querySelector("b")!.textContent, "[x]");
		}
	} finally {
		await fs.rm(workDir, { recursive: true, force: true });
	}
});

Deno.test("integration: instances of a partial nested through a slot patch only themselves", async () => {
	const workDir = await buildProject(NESTED_IN_SLOT_HTML);
	try {
		const mod = await import(path.join(workDir, "dist", "app.js"));
		const doc = await browserFor(workDir, renderRoot(mod.page as RootRNode, {}), "x-panel");
		const outer = doc.querySelector("#outer")!;
		const inner = doc.querySelector("#inner")!;
		const own = (panel: Element) => ({
			branch: panel.querySelector(":scope > header > p")!.textContent,
			set: panel.querySelector(":scope > section > i")!.textContent,
			print: panel.querySelector(":scope > span")!.textContent,
			attr: panel.querySelector(":scope > span")!.getAttribute("title"),
			call: panel.querySelector(":scope > plain-kid")!.getAttribute("data-t"),
		});
		await settled();
		assertEquals(own(outer), { branch: "o", set: "A", print: "o", attr: "o", call: "o" });
		assertEquals(own(inner), { branch: "i", set: "A", print: "i", attr: "i", call: "i" });

		outer.setAttribute("t", "o2");
		await settled();
		assertEquals(own(outer), { branch: "o2", set: "A", print: "o2", attr: "o2", call: "o2" });
		assertEquals(own(inner), { branch: "i", set: "A", print: "i", attr: "i", call: "i" });

		outer.removeAttribute("open");
		await settled();
		assertEquals(own(outer), { branch: "closed", set: "B", print: "o2", attr: "o2", call: "o2" });
		assertEquals(own(inner), { branch: "i", set: "A", print: "i", attr: "i", call: "i" });

		inner.setAttribute("t", "i2");
		await settled();
		assertEquals(own(inner), { branch: "i2", set: "A", print: "i2", attr: "i2", call: "i2" });
		assertEquals(own(outer), { branch: "closed", set: "B", print: "o2", attr: "o2", call: "o2" });
	} finally {
		await fs.rm(workDir, { recursive: true, force: true });
	}
});

Deno.test("integration: an element the HTML parser duplicates is reported when patched", async () => {
	const workDir = await buildProject(PARSER_COPY_HTML);
	const errors: unknown[][] = [];
	const orig = console.error;
	console.error = (...args: unknown[]) => { errors.push(args); };
	try {
		const mod = await import(path.join(workDir, "dist", "app.js"));
		const doc = await browserFor(workDir, renderRoot(mod.page as RootRNode, {}), "x-copy");
		const el = doc.querySelector("x-copy")!;
		await settled();
		// Reported at startup, when each site first looks up its element.
		assertEquals(errors.length, 1);
		assertStringIncludes(String(errors[0][0]), "data-bfid");

		el.setAttribute("t", "b");
		await settled();
		assertEquals(errors.length, 2);
		// Neither copy is patched: updating one would hide that something is wrong.
		assertEquals([...el.querySelectorAll("b")].map(b => b.getAttribute("title")), ["a", "a"]);
	} finally {
		console.error = orig;
		await fs.rm(workDir, { recursive: true, force: true });
	}
});

Deno.test("integration: a partial with hyphenated b-attrs registers, reads them and patches", async () => {
	const workDir = await buildProject(HYPHENATED_HTML);
	try {
		const mod = await import(path.join(workDir, "dist", "app.js"));
		const html = renderRoot(mod.page as RootRNode, {});
		const doc = await browserFor(workDir, html, "hy-badge");
		const el = doc.querySelector("hy-badge")!;

		assertEquals(doc.defaultView!.customElements.get("hy-badge") !== undefined, true);
		// deno-lint-ignore no-explicit-any
		const shell = (el as any).bfPatch;
		// Copied, since the object comes from the window's realm.
		assertEquals({ ...shell.collectData() }, { "data-id": "3", "is-open": true, count: "1" });

		el.setAttribute("count", "2");
		await settled();
		assertEquals(el.querySelector("span")!.getAttribute("data-count"), "2");
		assertEquals(el.querySelector("span")!.textContent, "2");

		el.setAttribute("data-id", "4");
		el.removeAttribute("is-open");
		await settled();
		assertEquals({ ...shell.collectData() }, { "data-id": "4", "is-open": false, count: "2" });
	} finally {
		await fs.rm(workDir, { recursive: true, force: true });
	}
});

Deno.test("integration: a full custom element registers itself and patches with no author JS", async () => {
	const workDir = await buildProject();
	try {
		const mod = await import(path.join(workDir, "dist", "app.js"));
		const html = renderRoot(mod.page as RootRNode, {});
		// The generated module is the entry: it is executed, not merely preloaded.
		assertStringIncludes(html, '<script src="/bfdom/count-badge.js" type="module"></script>');

		const doc = await browserFor(workDir, html);
		const el = doc.querySelector("count-badge")!;
		const content = () => el.innerHTML.replace(/<!--[^>]*-->/g, "").replace(/\s+/g, " ").trim();

		assertEquals(doc.defaultView!.customElements.get("count-badge") !== undefined, true);
		// Upgrading did not disturb what the server rendered.
		assertEquals(content(), '<span data-count="5" data-bfid="' + el.querySelector("span")!.getAttribute("data-bfid") + '">5</span> <em>Hurry</em>');

		// A print and a dynamic attribute.
		el.setAttribute("count", "12");
		await settled();
		assertStringIncludes(content(), 'data-count="12"');
		assertStringIncludes(content(), ">12</span>");

		// A reactive b-if set: the losing branch is rendered client-side and swapped in.
		el.removeAttribute("urgent");
		await settled();
		assertStringIncludes(content(), "<em>Relax</em>");
		el.setAttribute("urgent", "");
		await settled();
		assertStringIncludes(content(), "<em>Hurry</em>");
		// The count patched earlier survives the branch swap.
		assertStringIncludes(content(), ">12</span>");
	} finally {
		await fs.rm(workDir, { recursive: true, force: true });
	}
});
