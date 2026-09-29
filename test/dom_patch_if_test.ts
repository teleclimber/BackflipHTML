/**
 * End-to-end integration tests for reactive `b-if` in dom-patch, and for the
 * runtime files generated modules import.
 *
 * A module imports `render.js` to build a new branch client-side and `patch.js`
 * for the DOM helpers, so the CLI must copy each file a module imports into the
 * dom-patch output root and every module must reach it with a correct specifier.
 * A build that needs one while `dist` is absent has to fail loudly rather than
 * emit a page that 404s on import.
 */

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import * as path from "node:path";
import * as fs from "node:fs/promises";

const TMPDIR = "/tmp/claude-1000/dom-patch-if";
const REPO_ROOT = new URL("../", import.meta.url).pathname;
const CLI_PATH = path.join(REPO_ROOT, "cli.ts");

// A reactive custom element whose b-if set qualifies, plus a page that uses it.
const APP_HTML = `<mode-badge b-attr:mode b-script="@scripts/mode-badge.js">
	<div><p b-if="mode == 'a'">Ay</p><em b-else>Other</em></div>
</mode-badge>

<b-unwrap b-name="page" b-export>
	<body><mode-badge mode="a"></mode-badge></body>
</b-unwrap>`;

// No b-if, no print, and no element class (render mode), so nothing imports any runtime file.
const APP_NO_IF = `<mode-badge b-attr:mode b-generate="render" b-script="@scripts/mode-badge.js">
	<div :data-mode="mode">x</div>
</mode-badge>`;

// A print but no b-if: the module imports patch.js but not render.js.
const APP_PRINT_ONLY = `<mode-badge b-attr:mode b-script="@scripts/mode-badge.js">
	<div>{{ mode }}</div>
</mode-badge>`;

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

Deno.test("integration CLI: render.js and patch.js are copied into the dom-patch output root", async () => {
	const workDir = await makeProject("app.html", APP_HTML);
	try {
		const { code, stderr } = await runCli(workDir);
		assertEquals(code, 0, `cli failed: ${stderr}`);

		const renderPath = path.join(workDir, "bfdom", "render.js");
		assertEquals(await exists(renderPath), true, "render.js should be copied to the output root");
		// It is the real compiled runtime, not a stub.
		assertStringIncludes(await fs.readFile(renderPath, "utf-8"), "export function render");

		const patchPath = path.join(workDir, "bfdom", "patch.js");
		assertEquals(await exists(patchPath), true, "patch.js should be copied to the output root");
		assertStringIncludes(await fs.readFile(patchPath, "utf-8"), "export function replaceBetween");

		const generated = await fs.readFile(path.join(workDir, "bfdom", "mode-badge.js"), "utf-8");
		assertStringIncludes(generated, "import { render, activeBranchIndex } from './render.js';");
		assertStringIncludes(generated, "import { replaceBetween, BackflipElement } from './patch.js';");
		assertStringIncludes(generated, "createContextualFragment");
	} finally {
		await fs.rm(workDir, { recursive: true, force: true });
	}
});

Deno.test("integration CLI: a nested b-if compiles to nested patch-branch classes", async () => {
	const workDir = await makeProject("app.html", APP_NESTED);
	try {
		const { code, stderr } = await runCli(workDir);
		assertEquals(code, 0, `cli failed: ${stderr}`);

		const generated = await fs.readFile(path.join(workDir, "bfdom", "mode-badge.js"), "utf-8");
		// Two set snapshots (outer + inner) and a nested patch-branch class.
		assertEquals((generated.match(/const bfif_/g) ?? []).length, 2);
		assertStringIncludes(generated, "class BackflipPatch_ModeBadge {");
		assertEquals(/class BackflipPatch_bf[0-9a-z]+_0 \{/.test(generated), true);
		// The nested set is reached by forwarding `level` from the outer branch down.
		assertStringIncludes(generated, "case 'mode':");
		assertStringIncludes(generated, "case 'level':");

		// Server render emitted the taken branches with both marker pairs.
		const html = await fs.readFile(path.join(workDir, "dist", "app.js"), "utf-8");
		assertStringIncludes(html, "data-bfid");
	} finally {
		await fs.rm(workDir, { recursive: true, force: true });
	}
});

// A module is named after its partial and sits flat at the output root, however deep
// the template that defines it — so its runtime imports are always './<file>'.
Deno.test("integration CLI: a partial from a nested template still lands flat beside its runtime files", async () => {
	const workDir = await makeProject(path.join("deep", "nested", "app.html"), APP_HTML);
	try {
		const { code, stderr } = await runCli(workDir);
		assertEquals(code, 0, `cli failed: ${stderr}`);

		const modulePath = path.join(workDir, "bfdom", "mode-badge.js");
		const generated = await fs.readFile(modulePath, "utf-8");
		assertStringIncludes(generated, "import { render, activeBranchIndex } from './render.js';");
		assertEquals(await exists(path.join(workDir, "bfdom", "deep")), false);

		// Resolve each specifier the way the browser would, and check it lands on a real file.
		const specs = [...generated.matchAll(/^import \{[^}]*\} from '([^']+)';/gm)].map(m => m[1]);
		assertEquals(specs, ['./render.js', './patch.js']);
		for (const spec of specs) {
			const resolved = path.resolve(path.dirname(modulePath), spec);
			assertEquals(path.dirname(resolved), path.join(workDir, "bfdom"));
			assertEquals(await exists(resolved), true, `${spec} must resolve to a real file`);
		}
	} finally {
		await fs.rm(workDir, { recursive: true, force: true });
	}
});

Deno.test("integration CLI: no b-if and no print means no import and no copied runtime", async () => {
	const workDir = await makeProject("app.html", APP_NO_IF);
	try {
		const { code, stderr } = await runCli(workDir);
		assertEquals(code, 0, `cli failed: ${stderr}`);
		const generated = await fs.readFile(path.join(workDir, "bfdom", "mode-badge.js"), "utf-8");
		assertEquals(generated.includes("import"), false);
		assertEquals(await exists(path.join(workDir, "bfdom", "render.js")), false);
		assertEquals(await exists(path.join(workDir, "bfdom", "patch.js")), false);
	} finally {
		await fs.rm(workDir, { recursive: true, force: true });
	}
});

Deno.test("integration CLI: a print without b-if copies patch.js but not render.js", async () => {
	const workDir = await makeProject("app.html", APP_PRINT_ONLY);
	try {
		const { code, stderr } = await runCli(workDir);
		assertEquals(code, 0, `cli failed: ${stderr}`);
		const generated = await fs.readFile(path.join(workDir, "bfdom", "mode-badge.js"), "utf-8");
		assertStringIncludes(generated, "import { replaceBetween, BackflipElement } from './patch.js';");
		assertEquals(generated.includes("render.js"), false);
		assertEquals(await exists(path.join(workDir, "bfdom", "patch.js")), true);
		assertEquals(await exists(path.join(workDir, "bfdom", "render.js")), false);
	} finally {
		await fs.rm(workDir, { recursive: true, force: true });
	}
});

for (const [file, html] of [
	["render.js", APP_HTML],
	["patch.js", APP_PRINT_ONLY],
] as const) Deno.test(`integration CLI: a build that needs ${file} fails when dist is absent`, async () => {
	// Stand up a repo root that mirrors the real one but has no dist/: every entry
	// is symlinked except cli.ts, which is copied so its own relative imports (and
	// the import.meta.url used to locate dist) resolve inside this fake root.
	const fakeRoot = path.join(TMPDIR, `norel_${Date.now()}`);
	await fs.mkdir(fakeRoot, { recursive: true });
	for (const entry of await fs.readdir(REPO_ROOT)) {
		if (entry === "dist" || entry === "cli.ts") continue;
		await fs.symlink(path.join(REPO_ROOT, entry), path.join(fakeRoot, entry));
	}
	await fs.copyFile(CLI_PATH, path.join(fakeRoot, "cli.ts"));

	const workDir = await makeProject("app.html", html);
	try {
		const { code, stderr } = await runCli(workDir, path.join(fakeRoot, "cli.ts"));
		assertEquals(code, 1, `expected the build to fail; stderr: ${stderr}`);
		assertStringIncludes(stderr, "Missing required runtime file");
		assertStringIncludes(stderr, file);
	} finally {
		await fs.rm(workDir, { recursive: true, force: true });
		await fs.rm(fakeRoot, { recursive: true, force: true });
	}
});
