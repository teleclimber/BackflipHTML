/**
 * End-to-end integration tests for dom-patch script auto-include.
 *
 * Builds a template that uses a reactive custom element, runs the dom-patch
 * stamping + JS/PHP generation, renders, and asserts the renderer injects the
 * generated dom-patch module as a <link rel="modulepreload"> derived from the
 * asset prefix covering the dom-patch output dir. Also covers the rendered-only
 * rule (untaken b-if branch), the b-script entry module end-to-end, and the CLI
 * warning when the output dir is not under any asset prefix.
 */

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { compileDirectory } from "../compiler/partials.ts";
import { applyDomPatch } from "../compiler/generate/dom-patch/nodes2patch.ts";
import { resolveDomPatchScriptUrl, type BackflipConfig } from "../compiler/config.ts";
import { fileToJsModule } from "../compiler/generate/js/nodes2js.ts";
import { fileToPhpFile } from "../compiler/generate/php/nodes2php.ts";
import { renderRoot, streamRenderRoot, type RootRNode } from "../runtime/js/render.ts";

const TMPDIR = "/tmp/claude-1000/dom-patch-autoinclude";
const CLI_PATH = new URL("../cli.ts", import.meta.url).pathname;
const RENDER_PHP = new URL("../runtime/php/render.php", import.meta.url).pathname;

// A reactive custom element (`count-badge`) and a page partial that uses it.
const APP_HTML = `<count-badge b-attr:count>
	<span :data-count="count">{{ count }}</span>
</count-badge>

<b-unwrap b-name="page" b-export>
	<body>
		<count-badge count="5"></count-badge>
	</body>
</b-unwrap>

<b-unwrap b-name="conditional-page" b-export>
	<body>
		<b-unwrap b-if="show"><count-badge count="1"></count-badge></b-unwrap>
		<b-unwrap b-else>nothing</b-unwrap>
	</body>
</b-unwrap>`;

// dom-patch output dir == asset dir "bfdom" (the demo convention) → covered.
const COVERED_CONFIG: BackflipConfig = {
	root: ".",
	output: [{ lang: "dom-patch", path: "bfdom" }, { lang: "js", path: "dist" }],
	assets: [{ name: "bfdom", path: "bfdom", prefix: "/bfdom/" }],
};

function sanitize(name: string): string {
	return name.replace(/[^a-zA-Z0-9_$]/g, "_");
}

async function writeTemplates(files: Record<string, string>): Promise<string> {
	const root = path.join(TMPDIR, `t_${Date.now()}_${Math.random().toString(36).slice(2)}`);
	await fs.mkdir(root, { recursive: true });
	for (const [name, html] of Object.entries(files)) {
		const p = path.join(root, name);
		await fs.mkdir(path.dirname(p), { recursive: true });
		await fs.writeFile(p, html);
	}
	return root;
}

// Compile, stamp script URLs, generate same-file JS, eval, return the partial's
// RootRNode. dom-patch bakes random data-bfid values in at generation time, so a
// single build must be reused when comparing batch vs streaming output.
async function buildJsPartial(partialName: string, config: BackflipConfig): Promise<RootRNode> {
	const root = await writeTemplates({ "app.html": APP_HTML });
	try {
		const { directory } = await compileDirectory(root);
		for (const [relPath, file] of directory.files) {
			applyDomPatch(file, { scriptUrl: resolveDomPatchScriptUrl("/proj", config, relPath) ?? undefined });
		}
		const file = directory.files.get("app.html")!;
		const js = fileToJsModule(file, "app.html");
		const exportNames: string[] = [];
		const re = /^export const (\w+)/gm;
		let m;
		while ((m = re.exec(js)) !== null) exportNames.push(m[1]);
		const code = js.replace(/^export const /gm, "const ");
		const mod = new Function(code + `\nreturn { ${exportNames.join(", ")} };`)();
		return mod[sanitize(partialName)] as RootRNode;
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

async function buildAndRenderJs(partialName: string, ctx: any, config: BackflipConfig): Promise<string> {
	return renderRoot(await buildJsPartial(partialName, config), ctx);
}

Deno.test("integration JS: reactive custom element injects resolved script once before </body>", async () => {
	const html = await buildAndRenderJs("page", {}, COVERED_CONFIG);
	assertEquals(html.match(/<link rel="modulepreload"/g)?.length, 1);
	assertStringIncludes(html, '<link rel="modulepreload" href="/bfdom/app.js"></body>');
});

Deno.test("integration JS: untaken b-if branch excludes the script (rendered-only)", async () => {
	const taken = await buildAndRenderJs("conditional-page", { show: true }, COVERED_CONFIG);
	assertStringIncludes(taken, '<link rel="modulepreload" href="/bfdom/app.js">');

	const untaken = await buildAndRenderJs("conditional-page", { show: false }, COVERED_CONFIG);
	assertEquals(untaken.includes("<link"), false);
});

Deno.test("integration JS streaming: reactive custom element injects resolved script before </body>", async () => {
	const rnode = await buildJsPartial("page", COVERED_CONFIG);
	const streamed = Array.from(streamRenderRoot(rnode, {})).join("");
	assertEquals(streamed.match(/<link rel="modulepreload"/g)?.length, 1);
	assertStringIncludes(streamed, '<link rel="modulepreload" href="/bfdom/app.js"></body>');
	// Streaming output must equal batch output (same build, so bfids match).
	assertEquals(streamed, renderRoot(rnode, {}));
});

Deno.test("integration JS streaming: untaken b-if branch excludes the script", async () => {
	const rnode = await buildJsPartial("conditional-page", COVERED_CONFIG);
	const taken = Array.from(streamRenderRoot(rnode, { show: true })).join("");
	assertStringIncludes(taken, '<link rel="modulepreload" href="/bfdom/app.js">');

	const untaken = Array.from(streamRenderRoot(rnode, { show: false })).join("");
	assertEquals(untaken.includes("<link"), false);
});

Deno.test("integration PHP: reactive custom element injects resolved script before </body>", async () => {
	const root = await writeTemplates({ "app.html": APP_HTML });
	try {
		const { directory } = await compileDirectory(root);
		for (const [relPath, file] of directory.files) {
			applyDomPatch(file, { scriptUrl: resolveDomPatchScriptUrl("/proj", COVERED_CONFIG, relPath) ?? undefined });
		}
		const phpPath = path.join(root, "app.php");
		await fs.writeFile(phpPath, fileToPhpFile(directory.files.get("app.html")!, "app.html"));

		const harness = `<?php
require '${RENDER_PHP}';
$partials = require '${phpPath}';
echo backflip_renderRoot($partials['page'], []);
`;
		const harnessPath = path.join(root, "harness.php");
		await fs.writeFile(harnessPath, harness);
		const cmd = new Deno.Command("php", { args: [harnessPath], stdout: "piped", stderr: "piped" });
		const out = await cmd.output();
		const stdout = new TextDecoder().decode(out.stdout);
		const stderr = new TextDecoder().decode(out.stderr);
		assertEquals(out.code, 0, `php failed: ${stderr}`);
		assertEquals(stdout.match(/<link rel="modulepreload"/g)?.length, 1);
		assertStringIncludes(stdout, '<link rel="modulepreload" href="/bfdom/app.js"></body>');
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

Deno.test("integration PHP streaming: injects resolved script before </body> and equals batch", async () => {
	const root = await writeTemplates({ "app.html": APP_HTML });
	try {
		const { directory } = await compileDirectory(root);
		for (const [relPath, file] of directory.files) {
			applyDomPatch(file, { scriptUrl: resolveDomPatchScriptUrl("/proj", COVERED_CONFIG, relPath) ?? undefined });
		}
		const phpPath = path.join(root, "app.php");
		await fs.writeFile(phpPath, fileToPhpFile(directory.files.get("app.html")!, "app.html"));

		// Print streaming output and batch output separated by a NUL so we can
		// compare them and assert streaming injects the script too.
		const harness = `<?php
require '${RENDER_PHP}';
$partials = require '${phpPath}';
$stream = '';
foreach (backflip_streamRenderRoot($partials['page'], []) as $chunk) { $stream .= $chunk; }
echo $stream . "\\0" . backflip_renderRoot($partials['page'], []);
`;
		const harnessPath = path.join(root, "harness.php");
		await fs.writeFile(harnessPath, harness);
		const cmd = new Deno.Command("php", { args: [harnessPath], stdout: "piped", stderr: "piped" });
		const out = await cmd.output();
		const stdout = new TextDecoder().decode(out.stdout);
		const stderr = new TextDecoder().decode(out.stderr);
		assertEquals(out.code, 0, `php failed: ${stderr}`);
		const [streamed, batched] = stdout.split("\0");
		assertEquals(streamed.match(/<link rel="modulepreload"/g)?.length, 1);
		assertStringIncludes(streamed, '<link rel="modulepreload" href="/bfdom/app.js"></body>');
		assertEquals(streamed, batched);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

Deno.test("integration CLI: warns and stamps nothing when output dir is not under an asset prefix", async () => {
	const workDir = path.join(TMPDIR, `cli_${Date.now()}`);
	const templatesDir = path.join(workDir, "templates");
	await fs.mkdir(templatesDir, { recursive: true });
	await fs.writeFile(path.join(templatesDir, "app.html"), APP_HTML);
	// dom-patch output "build/bfdom" is NOT under the "static" asset dir → unservable.
	const config = {
		root: "templates",
		output: [{ lang: "dom-patch", path: "build/bfdom" }, { lang: "js", path: "dist" }],
		assets: [{ name: "static", path: "static", prefix: "/static/" }],
	};
	await fs.mkdir(path.join(workDir, "static"), { recursive: true });
	await fs.writeFile(path.join(workDir, "backflip.json"), JSON.stringify(config));

	try {
		const cmd = new Deno.Command("deno", {
			args: ["run", "--allow-read", "--allow-write", CLI_PATH],
			cwd: workDir,
			stdout: "piped",
			stderr: "piped",
		});
		const out = await cmd.output();
		const stderr = new TextDecoder().decode(out.stderr);
		assertEquals(out.code, 0, `cli failed: ${stderr}`);
		assertStringIncludes(stderr, "is not covered by an asset prefix");

		// The generated JS module must carry no scripts (auto-include inactive).
		const generatedJs = await fs.readFile(path.join(workDir, "dist", "app.js"), "utf-8");
		assertEquals(generatedJs.includes("scripts"), false);
	} finally {
		await fs.rm(workDir, { recursive: true, force: true });
	}
});

// b-script names the hand-coded entry module. End-to-end through the real CLI:
// it is resolved via the asset system, the generated dom-patch module is recorded
// as a dependency, both land in the emitted JS, the entry's file is validated to
// exist, and no "missing b-script" warning is produced.
const APP_WITH_BSCRIPT = `<count-badge b-attr:count b-script="@scripts/count-badge.js">
	<span :data-count="count">{{ count }}</span>
</count-badge>

<b-unwrap b-name="page" b-export>
	<body><count-badge count="5"></count-badge></body>
</b-unwrap>`;

Deno.test("integration CLI: b-script entry + generated dependency both emitted, file validated, no warning", async () => {
	const workDir = path.join(TMPDIR, `cli_bscript_${Date.now()}`);
	const templatesDir = path.join(workDir, "templates");
	await fs.mkdir(templatesDir, { recursive: true });
	await fs.writeFile(path.join(templatesDir, "app.html"), APP_WITH_BSCRIPT);
	// The hand-coded entry module must exist on disk for asset validation to pass.
	await fs.mkdir(path.join(workDir, "scripts"), { recursive: true });
	await fs.writeFile(path.join(workDir, "scripts", "count-badge.js"), "// hand-coded\n");
	const config = {
		root: "templates",
		output: [{ lang: "dom-patch", path: "bfdom" }, { lang: "js", path: "dist" }],
		assets: [
			{ name: "bfdom", path: "bfdom", prefix: "/bfdom/" },
			{ name: "scripts", path: "scripts", prefix: "/scripts/" },
		],
	};
	await fs.mkdir(path.join(workDir, "bfdom"), { recursive: true });
	await fs.writeFile(path.join(workDir, "backflip.json"), JSON.stringify(config));

	try {
		const cmd = new Deno.Command("deno", {
			args: ["run", "--allow-read", "--allow-write", CLI_PATH],
			cwd: workDir,
			stdout: "piped",
			stderr: "piped",
		});
		const out = await cmd.output();
		const stderr = new TextDecoder().decode(out.stderr);
		assertEquals(out.code, 0, `cli failed: ${stderr}`);
		assertEquals(stderr.includes("no b-script"), false);
		assertEquals(stderr.includes("not covered by an asset prefix"), false);

		const generatedJs = await fs.readFile(path.join(workDir, "dist", "app.js"), "utf-8");
		assertStringIncludes(generatedJs, "{ url: '/scripts/count-badge.js', kind: 'entry' }");
		assertStringIncludes(generatedJs, "{ url: '/bfdom/app.js', kind: 'dependency' }");
	} finally {
		await fs.rm(workDir, { recursive: true, force: true });
	}
});
