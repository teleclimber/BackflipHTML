/**
 * End-to-end test for a generated partial that reads a store: build a project with the
 * real CLI, render the page with the JS runtime and the store data, then run the
 * generated module, the store file and the runtime against that HTML in jsdom.
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

const TMPDIR = "/tmp/claude-1000/stores-generate";
const CLI_PATH = new URL("../cli.ts", import.meta.url).pathname;

const APP_HTML = `<my-widget b-store:widgets b-attr:widget_id b-generate="full">
	<h3>{{ widgets.data[widget_id] ? widgets.data[widget_id].name : '' }}</h3>
	<em b-if="widgets.data.sale">Sale</em>
	<em b-else>Regular</em>
</my-widget>

<b-unwrap b-name="page" b-export>
	<body><my-widget widget_id="42"></my-widget></body>
</b-unwrap>`;

const STORE_JS = `import { BackflipStore } from '/static/bfdom/runtime/dom-patch/stores.js';

class Widgets extends BackflipStore {
	count() { return Object.keys(this.data).length; }
}

export default new Widgets('widgets');
`;

const STORES = { widgets: { "42": { name: "Gizmo" }, "7": { name: "Widget" }, sale: true } };

async function buildProject(): Promise<string> {
	const workDir = path.join(TMPDIR, `p_${Date.now()}_${Math.random().toString(36).slice(2)}`);
	for (const dir of ["templates", "static/stores", "static/bfdom"]) await fs.mkdir(path.join(workDir, dir), { recursive: true });
	await fs.writeFile(path.join(workDir, "templates", "app.html"), APP_HTML);
	await fs.writeFile(path.join(workDir, "static", "stores", "widgets.js"), STORE_JS);
	await fs.writeFile(path.join(workDir, "backflip.json"), JSON.stringify({
		root: "templates",
		output: [{ lang: "dom-patch", path: "static/bfdom" }, { lang: "js", path: "dist" }],
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

Deno.test("integration: a generated partial reads its store in the browser", async () => {
	const workDir = await buildProject();
	try {
		// The build copies the store runtime beside the other runtime files.
		await fs.stat(path.join(workDir, "static/bfdom/runtime/dom-patch/stores.js"));
		const moduleJs = await fs.readFile(path.join(workDir, "static/bfdom/my-widget.js"), "utf-8");
		assertStringIncludes(moduleJs, `import bfstore_widgets from "/static/stores/widgets.js";`);

		const mod = await import(path.join(workDir, "dist", "app.js"));
		const html = renderRoot(mod.page as RootRNode, {}, undefined, STORES);
		assertStringIncludes(html, `<script type="application/json" data-bf-store="widgets">`);
		assertStringIncludes(html, `<link rel="modulepreload" href="/static/stores/widgets.js">`);
		assertStringIncludes(html, `<script src="/static/bfdom/my-widget.js" type="module"></script>`);

		const src = await linkAsScript(path.join(workDir, "static/bfdom/my-widget.js"), { "/static/": path.join(workDir, "static") });
		const dom = new JSDOM(`<!DOCTYPE html>${html}`, { runScripts: "outside-only" });
		await new Promise(resolve => dom.window.addEventListener("load", resolve, { once: true }));
		dom.window.eval(src);
		const doc = dom.window.document;
		const el = doc.querySelector("my-widget")!;
		const content = () => el.innerHTML.replace(/<!--[^>]*-->/g, "").replace(/ data-bfid="[^"]*"/g, "").replace(/\s+/g, " ").trim();

		assertEquals(doc.defaultView!.customElements.get("my-widget") !== undefined, true);
		// Upgrading did not disturb what the server rendered from the store.
		assertEquals(content(), "<h3>Gizmo</h3> <em>Sale</em>");

		// A mixed expression re-patches from the store when its attribute changes.
		el.setAttribute("widget_id", "7");
		assertEquals(content(), "<h3>Widget</h3> <em>Sale</em>");
		el.setAttribute("widget_id", "99");
		assertEquals(content(), "<h3></h3> <em>Sale</em>");
	} finally {
		await fs.rm(workDir, { recursive: true, force: true });
	}
});
