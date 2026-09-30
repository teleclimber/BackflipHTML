/**
 * End-to-end integration tests for reactive `b-if` in dom-patch, and for the
 * runtime generated modules run on.
 *
 * A module imports `runtime/dom-patch/patch.js`, which imports `runtime/js/render.js`,
 * so the CLI must copy both into the dom-patch output dir at those same relative
 * paths, where every import resolves. A build that needs them while `dist` is absent
 * has to fail loudly rather than emit a page that 404s on import.
 */

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { compileDirectory } from "../compiler/partials.ts";
import { applyDomPatch } from "../compiler/generate/dom-patch/nodes2patch.ts";
import { fileToJsModule } from "../compiler/generate/js/nodes2js.ts";
import { fileToPhpFile } from "../compiler/generate/php/nodes2php.ts";
import { renderRoot, type RootRNode } from "../runtime/js/render.ts";

const TMPDIR = "/tmp/claude-1000/dom-patch-if";
const REPO_ROOT = new URL("../", import.meta.url).pathname;
const CLI_PATH = path.join(REPO_ROOT, "cli.ts");
const RENDER_PHP = path.join(REPO_ROOT, "runtime/php/render.php");

// A reactive custom element whose b-if set qualifies, plus a page that uses it.
const APP_HTML = `<mode-badge b-attr:mode b-script="@scripts/mode-badge.js">
	<div><p b-if="mode == 'a'">Ay</p><em b-else>Other</em></div>
</mode-badge>

<b-unwrap b-name="page" b-export>
	<body><mode-badge mode="a"></mode-badge></body>
</b-unwrap>`;

// The smallest module: an element class with nothing to patch.
const APP_ELEMENT_ONLY = `<mode-badge b-attr:mode b-script="@scripts/mode-badge.js">
	<div>x</div>
</mode-badge>`;

// No partial generates client JS, so there is no module and no runtime to copy.
const APP_NO_MODULE = `<b-unwrap b-name="page" b-export>
	<body>static</body>
</b-unwrap>`;

const RUNTIME = ["runtime/js/render.js", "runtime/dom-patch/patch.js"];

// A nested b-if: the outer set (mode) contains an inner set (level) whose branch
// prints a live var. Both sets are reactive; the inner one is its own patch-branch.
const APP_NESTED = `<mode-badge b-attr:mode b-attr:level b-script="@scripts/mode-badge.js">
	<div b-if="mode == 'a'"><p b-if="level == 'hi'">{{ level }}</p><em b-else>lo</em></div>
	<span b-else>other</span>
</mode-badge>

<b-unwrap b-name="page" b-export>
	<body><mode-badge mode="a" level="hi"></mode-badge></body>
</b-unwrap>`;

/**
 * Lay out a project: templates at `templates/<relPath>`, a hand-coded entry
 * module for b-script, and a config whose dom-patch output doubles as an asset dir.
 */
async function makeProject(relPath: string, html: string): Promise<string> {
	const workDir = path.join(TMPDIR, `p_${Date.now()}_${Math.random().toString(36).slice(2)}`);
	const templatePath = path.join(workDir, "templates", relPath);
	await fs.mkdir(path.dirname(templatePath), { recursive: true });
	await fs.writeFile(templatePath, html);
	await fs.mkdir(path.join(workDir, "scripts"), { recursive: true });
	await fs.writeFile(path.join(workDir, "scripts", "mode-badge.js"), "// hand-coded\n");
	await fs.mkdir(path.join(workDir, "bfdom"), { recursive: true });
	const config = {
		root: "templates",
		output: [{ lang: "dom-patch", path: "bfdom" }, { lang: "js", path: "dist" }],
		assets: [
			{ name: "bfdom", path: "bfdom", prefix: "/bfdom/" },
			{ name: "scripts", path: "scripts", prefix: "/scripts/" },
		],
	};
	await fs.writeFile(path.join(workDir, "backflip.json"), JSON.stringify(config));
	return workDir;
}

async function runCli(cwd: string, cliPath = CLI_PATH) {
	const cmd = new Deno.Command("deno", {
		args: ["run", "--allow-read", "--allow-write", cliPath],
		cwd,
		stdout: "piped",
		stderr: "piped",
	});
	const out = await cmd.output();
	return {
		code: out.code,
		stdout: new TextDecoder().decode(out.stdout),
		stderr: new TextDecoder().decode(out.stderr),
	};
}

async function exists(p: string): Promise<boolean> {
	try { await Deno.stat(p); return true; } catch { return false; }
}

Deno.test("integration CLI: the runtime is copied into the output dir at its dist-relative paths", async () => {
	const workDir = await makeProject("app.html", APP_HTML);
	try {
		const { code, stderr } = await runCli(workDir);
		assertEquals(code, 0, `cli failed: ${stderr}`);

		// The real compiled runtime, not stubs.
		const renderJs = await fs.readFile(path.join(workDir, "bfdom", "runtime/js/render.js"), "utf-8");
		assertStringIncludes(renderJs, "export function render");
		const patchJs = await fs.readFile(path.join(workDir, "bfdom", "runtime/dom-patch/patch.js"), "utf-8");
		assertStringIncludes(patchJs, "export class PatchBranch");

		const generated = await fs.readFile(path.join(workDir, "bfdom", "mode-badge.js"), "utf-8");
		assertStringIncludes(generated, "import { BackflipShell, BackflipElement } from './runtime/dom-patch/patch.js';");
	} finally {
		await fs.rm(workDir, { recursive: true, force: true });
	}
});

Deno.test("integration CLI: a nested b-if compiles to nested set descriptors", async () => {
	const workDir = await makeProject("app.html", APP_NESTED);
	try {
		const { code, stderr } = await runCli(workDir);
		assertEquals(code, 0, `cli failed: ${stderr}`);

		const generated = await fs.readFile(path.join(workDir, "bfdom", "mode-badge.js"), "utf-8");
		// Two set snapshots (outer + inner), each referenced by its own set descriptor.
		assertEquals((generated.match(/^const bfif_/gm) ?? []).length, 2);
		assertEquals((generated.match(/snapshot: bfif_/g) ?? []).length, 2);
		// The inner set is reached by forwarding `level` from the outer set down.
		assertStringIncludes(generated, "subtreeVars: ['level']");

		// Server render emitted the taken branches with both marker pairs.
		const html = await fs.readFile(path.join(workDir, "dist", "app.js"), "utf-8");
		assertStringIncludes(html, "data-bfid");
	} finally {
		await fs.rm(workDir, { recursive: true, force: true });
	}
});

// Resolve every relative import in `file` the way the browser would, and follow them.
async function assertImportsResolve(file: string, seen = new Set<string>()): Promise<void> {
	if (seen.has(file)) return;
	seen.add(file);
	assertEquals(await exists(file), true, `${file} must exist`);
	const src = await fs.readFile(file, "utf-8");
	for (const [, spec] of src.matchAll(/^import [^;]* from '(\.[^']+)';/gm)) {
		await assertImportsResolve(path.resolve(path.dirname(file), spec), seen);
	}
}

// A module is named after its partial and sits flat at the output root, however deep
// the template that defines it — so its runtime import is always the same path.
Deno.test("integration CLI: a partial from a nested template lands flat, and every import resolves", async () => {
	const workDir = await makeProject(path.join("deep", "nested", "app.html"), APP_HTML);
	try {
		const { code, stderr } = await runCli(workDir);
		assertEquals(code, 0, `cli failed: ${stderr}`);

		const modulePath = path.join(workDir, "bfdom", "mode-badge.js");
		assertEquals(await exists(path.join(workDir, "bfdom", "deep")), false);
		// The module's import of patch.js, and patch.js's own import of render.js.
		await assertImportsResolve(modulePath);
	} finally {
		await fs.rm(workDir, { recursive: true, force: true });
	}
});

Deno.test("integration CLI: any generated module copies the whole runtime", async () => {
	const workDir = await makeProject("app.html", APP_ELEMENT_ONLY);
	try {
		const { code, stderr } = await runCli(workDir);
		assertEquals(code, 0, `cli failed: ${stderr}`);
		for (const file of RUNTIME) {
			assertEquals(await exists(path.join(workDir, "bfdom", file)), true, `${file} should be copied`);
		}
		await assertImportsResolve(path.join(workDir, "bfdom", "mode-badge.js"));
	} finally {
		await fs.rm(workDir, { recursive: true, force: true });
	}
});

Deno.test("integration CLI: no generated module means no runtime copied", async () => {
	const workDir = await makeProject("app.html", APP_NO_MODULE);
	try {
		const { code, stderr } = await runCli(workDir);
		assertEquals(code, 0, `cli failed: ${stderr}`);
		assertEquals(await exists(path.join(workDir, "bfdom", "runtime")), false);
	} finally {
		await fs.rm(workDir, { recursive: true, force: true });
	}
});

for (const missing of RUNTIME) Deno.test(`integration CLI: a build fails when dist lacks ${missing}`, async () => {
	// Stand up a repo root that mirrors the real one but whose dist/ holds only the
	// other runtime file: every entry is symlinked except cli.ts, which is copied so
	// its own relative imports (and the import.meta.url used to locate dist) resolve
	// inside this fake root.
	const fakeRoot = path.join(TMPDIR, `norel_${Date.now()}`);
	await fs.mkdir(fakeRoot, { recursive: true });
	for (const entry of await fs.readdir(REPO_ROOT)) {
		if (entry === "dist" || entry === "cli.ts") continue;
		await fs.symlink(path.join(REPO_ROOT, entry), path.join(fakeRoot, entry));
	}
	await fs.copyFile(CLI_PATH, path.join(fakeRoot, "cli.ts"));
	for (const file of RUNTIME.filter(f => f !== missing)) {
		await fs.mkdir(path.dirname(path.join(fakeRoot, "dist", file)), { recursive: true });
		await fs.copyFile(path.join(REPO_ROOT, "dist", file), path.join(fakeRoot, "dist", file));
	}

	const workDir = await makeProject("app.html", APP_ELEMENT_ONLY);
	try {
		const { code, stderr } = await runCli(workDir, path.join(fakeRoot, "cli.ts"));
		assertEquals(code, 1, `expected the build to fail; stderr: ${stderr}`);
		assertStringIncludes(stderr, "Missing required runtime file");
		assertStringIncludes(stderr, missing);
	} finally {
		await fs.rm(workDir, { recursive: true, force: true });
		await fs.rm(fakeRoot, { recursive: true, force: true });
	}
});

// --- branch markers in the server render -------------------------------------

// One page per branch of a three-branch set, so each render has exactly one winner.
const APP_BRANCHES = `<mode-badge b-attr:mode b-generate="full">
	<div><p b-if="mode == 'a'">Ay</p><em b-else-if="mode == 'b'">Bee</em><i b-else>Other</i></div>
</mode-badge>

<b-unwrap b-name="pagea" b-export><mode-badge mode="a"></mode-badge></b-unwrap>
<b-unwrap b-name="pageb" b-export><mode-badge mode="b"></mode-badge></b-unwrap>
<b-unwrap b-name="pagec" b-export><mode-badge mode="c"></mode-badge></b-unwrap>`;

const PAGES = ["pagea", "pageb", "pagec"];

// The branch markers in rendered HTML, as the branch index each names.
function renderedBranches(html: string): number[] {
	return [...html.matchAll(/<!--bfid:[^:>]+:(\d+)-->/g)].map(m => Number(m[1]));
}

async function compileBranchesApp(): Promise<{ root: string, file: any }> {
	const root = path.join(TMPDIR, `b_${Date.now()}_${Math.random().toString(36).slice(2)}`);
	await fs.mkdir(root, { recursive: true });
	await fs.writeFile(path.join(root, "app.html"), APP_BRANCHES);
	const { directory } = await compileDirectory(root);
	const file = directory.files.get("app.html")!;
	applyDomPatch(file);
	return { root, file };
}

Deno.test("integration JS: the server render carries only the winning branch's marker", async () => {
	const { root, file } = await compileBranchesApp();
	try {
		const js = fileToJsModule(file, "app.html");
		const names = [...js.matchAll(/^export const (\w+)/gm)].map(m => m[1]);
		const mod = new Function(js.replace(/^export const /gm, "const ") + `\nreturn { ${names.join(", ")} };`)();
		const rendered = PAGES.map(p => renderedBranches(renderRoot(mod[p] as RootRNode, {})));
		assertEquals(rendered, [[0], [1], [2]]);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

Deno.test("integration PHP: the server render carries only the winning branch's marker", async () => {
	const { root, file } = await compileBranchesApp();
	try {
		const phpPath = path.join(root, "app.php");
		await fs.writeFile(phpPath, fileToPhpFile(file, "app.html"));
		const harness = `<?php
require '${RENDER_PHP}';
$partials = require '${phpPath}';
foreach (${JSON.stringify(PAGES)} as $p) { echo backflip_renderRoot($partials[$p], []) . "\\0"; }
`;
		const harnessPath = path.join(root, "harness.php");
		await fs.writeFile(harnessPath, harness);
		const out = await new Deno.Command("php", { args: [harnessPath], stdout: "piped", stderr: "piped" }).output();
		assertEquals(out.code, 0, `php failed: ${new TextDecoder().decode(out.stderr)}`);
		const pages = new TextDecoder().decode(out.stdout).split("\0").slice(0, -1);
		assertEquals(pages.map(renderedBranches), [[0], [1], [2]]);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
