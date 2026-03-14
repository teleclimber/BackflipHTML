/**
 * End-to-end integration tests: compile templates → generate PHP → render HTML via PHP CLI.
 *
 * Pipeline: compileDirectory → fileToPhpFile → write .php to temp dir →
 *           run PHP harness script → assert stdout matches expected HTML.
 *
 * Mirrors integration_test.ts exactly: same templates, same contexts, same expected outputs.
 */

import { assertEquals } from "jsr:@std/assert";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { compileDirectory } from "../compiler/partials.ts";
import { fileToPhpFile } from "../compiler/generate/php/nodes2php.ts";

const TEMPLATES_DIR = new URL("./templates", import.meta.url).pathname;
const TMPDIR = "/tmp/claude-1000/integration-php-test-output";
const RENDER_PHP = new URL("../runtime/php/render.php", import.meta.url).pathname;

// Compile once for all tests
const compiled = await compileDirectory(TEMPLATES_DIR);

// Write all generated PHP files to TMPDIR once
await fs.mkdir(TMPDIR, { recursive: true });
for (const [filename, file] of compiled.files) {
    const phpPath = path.join(TMPDIR, filename.replace(".html", ".php"));
    await fs.writeFile(phpPath, fileToPhpFile(file, filename), "utf-8");
}

/**
 * Normalize rendered HTML for comparison: collapse whitespace-only gaps between
 * tags and trim leading/trailing whitespace.
 */
function normalize(html: string): string {
    return html.replace(/>\s+</g, "><").trim();
}

/**
 * Convert a JS value to a PHP array literal string for embedding in harness scripts.
 * Handles strings, numbers, booleans, null, arrays, and plain objects.
 */
function phpValue(v: unknown): string {
    if (v === null) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return String(v);
    if (typeof v === "string") return "'" + v.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
    if (Array.isArray(v)) return "[" + v.map(phpValue).join(", ") + "]";
    if (typeof v === "object") {
        const pairs = Object.entries(v as Record<string, unknown>)
            .map(([k, val]) => `'${k}' => ${phpValue(val)}`);
        return "[" + pairs.join(", ") + "]";
    }
    return "null";
}

/** Run a PHP harness script and return stdout. */
async function runPhp(script: string): Promise<string> {
    const harnessPath = path.join(TMPDIR, `_harness_${Date.now()}_${Math.random().toString(36).slice(2)}.php`);
    await fs.writeFile(harnessPath, script, "utf-8");
    const cmd = new Deno.Command("php", {
        args: [harnessPath],
        stdout: "piped",
        stderr: "piped",
    });
    const { stdout, stderr, code } = await cmd.output();
    if (code !== 0) throw new Error(new TextDecoder().decode(stderr));
    await fs.unlink(harnessPath);
    return new TextDecoder().decode(stdout);
}

/**
 * Render a named partial via PHP CLI.
 *
 * @param partialFile  template filename, e.g. "simple.html"
 * @param partialName  partial name within that file, e.g. "greeting"
 * @param ctx          context object — converted to PHP array literal
 * @param slots        optional raw PHP slots literal, e.g. "['default' => ['nodes' => [...], 'ctx' => []]]"
 */
async function renderPhp(
    partialFile: string,
    partialName: string,
    ctx: Record<string, unknown>,
    slots = ""
): Promise<string> {
    const phpFile = path.join(TMPDIR, partialFile.replace(".html", ".php"));
    const ctxLiteral = phpValue(ctx);
    const slotsArg = slots ? `, ${slots}` : "";
    const script = `<?php
declare(strict_types=1);
require '${RENDER_PHP}';
$files = backflip_require('${phpFile}');
echo backflip_renderRoot($files['${partialName}'], ${ctxLiteral}${slotsArg});
`;
    return runPhp(script);
}

// ---------------------------------------------------------------------------
// simple.html — basic print expression inside a named element
// ---------------------------------------------------------------------------

Deno.test("php: greeting: renders <p> with interpolated name", async () => {
    assertEquals(
        await renderPhp("simple.html", "greeting", { name: "World" }),
        "<p>Hello, World!</p>"
    );
});

Deno.test("php: greeting: renders with a different name", async () => {
    assertEquals(
        await renderPhp("simple.html", "greeting", { name: "Alice" }),
        "<p>Hello, Alice!</p>"
    );
});

// ---------------------------------------------------------------------------
// blog.html — b-for and b-if/b-else
// ---------------------------------------------------------------------------

Deno.test("php: post-list: renders b-for loop over items", async () => {
    assertEquals(
        normalize(await renderPhp("blog.html", "post_list", { posts: ["Alpha", "Beta"] })),
        "<ul><li>Alpha</li><li>Beta</li></ul>"
    );
});

Deno.test("php: post-list: renders empty list", async () => {
    assertEquals(
        normalize(await renderPhp("blog.html", "post_list", { posts: [] })),
        "<ul></ul>"
    );
});

Deno.test("php: conditional: b-if true branch", async () => {
    assertEquals(
        normalize(await renderPhp("blog.html", "conditional", { show: true })),
        "<p>Shown</p>"
    );
});

Deno.test("php: conditional: b-else false branch", async () => {
    assertEquals(
        normalize(await renderPhp("blog.html", "conditional", { show: false })),
        "<p>Hidden</p>"
    );
});

// ---------------------------------------------------------------------------
// ui.html — default slot passing between same-file partials
// ---------------------------------------------------------------------------

Deno.test("php: demo: slot content rendered inside btn via b-part", async () => {
    assertEquals(
        normalize(await renderPhp("ui.html", "demo", {})),
        "<div><button>Click me</button></div>"
    );
});

Deno.test("php: btn: renders slot content when called directly", async () => {
    const slots = `['default' => ['nodes' => [['type' => 'raw', 'raw' => 'Submit']], 'ctx' => []]]`;
    assertEquals(
        await renderPhp("ui.html", "btn", {}, slots),
        "<button>Submit</button>"
    );
});

Deno.test("php: btn: renders empty button when no slot content provided", async () => {
    assertEquals(
        await renderPhp("ui.html", "btn", {}),
        "<button></button>"
    );
});

// ---------------------------------------------------------------------------
// data.html — b-data: passes expressions to partials
// ---------------------------------------------------------------------------

Deno.test("php: profile: b-data:label passes user.name into badge", async () => {
    assertEquals(
        normalize(await renderPhp("data.html", "profile", { user: { name: "Alice" } })),
        "Alice"
    );
});

Deno.test("php: badge: renders label directly when called with context", async () => {
    assertEquals(
        await renderPhp("data.html", "badge", { label: "hello" }),
        "hello"
    );
});

// ---------------------------------------------------------------------------
// Cross-file: page.html references partials defined in components.html
// Both .php files are already written to TMPDIR, so __DIR__ resolution works.
// ---------------------------------------------------------------------------

Deno.test("php: cross-file: labeled renders label partial from components.html", async () => {
    assertEquals(
        normalize(await renderPhp("page.html", "labeled", { msg: "Hello from components" })),
        "Hello from components"
    );
});

Deno.test("php: cross-file: boxed renders box partial with slot content from components.html", async () => {
    assertEquals(
        normalize(await renderPhp("page.html", "boxed", {})),
        "<div><div class=\"box\"><span>Hi</span></div></div>"
    );
});

Deno.test("php: cross-file: label partial in components.html renders correctly", async () => {
    assertEquals(
        await renderPhp("components.html", "label", { text: "direct" }),
        "direct"
    );
});

Deno.test("php: cross-file: box partial in components.html renders slot content", async () => {
    const slots = `['default' => ['nodes' => [['type' => 'raw', 'raw' => 'content']], 'ctx' => []]]`;
    assertEquals(
        normalize(await renderPhp("components.html", "box", {}, slots)),
        "<div class=\"box\">content</div>"
    );
});
