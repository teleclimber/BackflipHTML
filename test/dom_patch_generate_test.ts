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

const TMPDIR = "/tmp/claude-1000/dom-patch-generate";
const CLI_PATH = new URL("../cli.ts", import.meta.url).pathname;

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

async function buildProject(): Promise<string> {
	const workDir = path.join(TMPDIR, `p_${Date.now()}_${Math.random().toString(36).slice(2)}`);
	await fs.mkdir(path.join(workDir, "templates"), { recursive: true });
	await fs.mkdir(path.join(workDir, "bfdom"), { recursive: true });
	await fs.writeFile(path.join(workDir, "templates", "app.html"), APP_HTML);
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
 * Put the server-rendered HTML in a window and run the generated module in it. Each
 * runtime import is bound by running the file the build copied beside the module in
 * that window, so the element base class extends the window's HTMLElement. The
 * document is fully parsed first, as it is for the deferred module script the
 * renderer injects.
 */
async function browserFor(workDir: string, html: string) {
	const outDir = path.join(workDir, "bfdom");
	const mod = await fs.readFile(path.join(outDir, "count-badge.js"), "utf-8");
	const imports = [...mod.matchAll(/^import \{([^}]*)\} from '\.\/([^']+)';$/gm)];
	const bindings = await Promise.all(imports.map(async ([, names, file]) => {
		const runtime = (await fs.readFile(path.join(outDir, file), "utf-8")).replace(/^export /gm, "");
		return `const {${names}} = (() => {\n${runtime}\nreturn {${names}};\n})();`;
	}));
	const src = [
		...bindings,
		mod.replace(/^import .*$/gm, "").replaceAll("export class", "class"),
	].join("\n");
	const dom = new JSDOM(`<!DOCTYPE html>${html}`, { runScripts: "outside-only" });
	await new Promise(resolve => dom.window.addEventListener("load", resolve, { once: true }));
	dom.window.eval(src);
	return dom.window.document;
}

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
		assertStringIncludes(content(), 'data-count="12"');
		assertStringIncludes(content(), ">12</span>");

		// A reactive b-if set: the losing branch is rendered client-side and swapped in.
		el.removeAttribute("urgent");
		assertStringIncludes(content(), "<em>Relax</em>");
		el.setAttribute("urgent", "");
		assertStringIncludes(content(), "<em>Hurry</em>");
		// The count patched earlier survives the branch swap.
		assertStringIncludes(content(), ">12</span>");
	} finally {
		await fs.rm(workDir, { recursive: true, force: true });
	}
});
