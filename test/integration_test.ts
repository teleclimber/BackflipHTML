/**
 * End-to-end integration tests: compile templates → generate JS → render HTML.
 *
 * Pipeline: compileDirectory → fileToJsModule → (eval or dynamic import) → renderRoot
 *
 * Same-file partial tests evaluate generated JS directly via new Function().
 * Cross-file partial tests write JS modules to a temp dir and use dynamic import()
 * so that static `import` statements between modules resolve correctly.
 */

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { compileDirectory } from "../compiler/partials.ts";
import { fileToJsModule } from "../compiler/generate/js/nodes2js.ts";
import { renderRoot } from "../runtime/js/render.ts";
import type { RootRNode } from "../runtime/js/render.ts";

const TEMPLATES_DIR = new URL("./templates", import.meta.url).pathname;
const TMPDIR = "/tmp/claude-1000/integration-test-output";

// Compile once for all tests
const { directory: compiled } = await compileDirectory(TEMPLATES_DIR);

/**
 * Normalize rendered HTML for comparison: collapse whitespace-only gaps between
 * tags and trim leading/trailing whitespace. This lets templates be formatted
 * for readability without affecting test assertions.
 *
 * Example: "\n    <ul>\n        <li>x</li>\n    </ul>\n" → "<ul><li>x</li></ul>"
 */
function normalize(html: string): string {
    return html.replace(/>\s+</g, "><").trim();
}

// ---------------------------------------------------------------------------
// Helpers for same-file tests (no import statements in generated JS)
// ---------------------------------------------------------------------------

function getModule(filename: string): Record<string, RootRNode> {
    const file = compiled.files.get(filename);
    if (!file) throw new Error(`File not compiled: ${filename}`);
    const js = fileToJsModule(file, filename);

    // Collect all export names and strip 'export' keywords so new Function() can evaluate
    const exportNames: string[] = [];
    const pattern = /^export const (\w+)/gm;
    let m;
    while ((m = pattern.exec(js)) !== null) exportNames.push(m[1]);
    const code = js.replace(/^export const /gm, "const ");
    return new Function(code + `\nreturn { ${exportNames.join(", ")} };`)();
}

// ---------------------------------------------------------------------------
// Helpers for cross-file tests (generated JS has import statements)
// ---------------------------------------------------------------------------

/** Write all compiled files as .js modules to outDir, then import each one. */
async function buildModules(outDir: string): Promise<Map<string, Record<string, RootRNode>>> {
    await fs.mkdir(outDir, { recursive: true });
    for (const [filename, file] of compiled.files) {
        const jsPath = path.join(outDir, filename.replace(".html", ".js"));
        await fs.writeFile(jsPath, fileToJsModule(file, filename), "utf-8");
    }
    const result = new Map<string, Record<string, RootRNode>>();
    for (const filename of compiled.files.keys()) {
        const jsUrl = `file://${path.join(outDir, filename.replace(".html", ".js"))}`;
        result.set(filename, await import(jsUrl));
    }
    return result;
}

const crossFileModules = await buildModules(TMPDIR);

// ---------------------------------------------------------------------------
// simple.html — basic print expression inside a named element
//
// Template:  <p b-name="greeting">Hello, {{ name }}!</p>
//
// The partial includes the <p> wrapper. parse5 emits no extra whitespace since
// the text content is inline on the same line as the tags.
// Expected: <p>Hello, {name}!</p>
// ---------------------------------------------------------------------------

Deno.test("greeting: renders <p> with interpolated name", () => {
    assertEquals(
        renderRoot(getModule("simple.html").greeting, { name: "World" }),
        "<p>Hello, World!</p>"
    );
});

Deno.test("greeting: escapes HTML in interpolated value", () => {
    assertStringIncludes(
        renderRoot(getModule("simple.html").greeting, { name: "<script>alert(1)</script>" }),
        "&lt;script&gt;alert(1)&lt;/script&gt;"
    );
});

Deno.test("greeting: renders with a different name", () => {
    assertEquals(
        renderRoot(getModule("simple.html").greeting, { name: "Alice" }),
        "<p>Hello, Alice!</p>"
    );
});

// ---------------------------------------------------------------------------
// blog.html — b-for and b-if/b-else
//
// Template (post-list):
//   <b-unwrap b-name="post-list">
//       <ul>
//           <li b-for="post in posts">{{ post }}</li>
//       </ul>
//   </b-unwrap>
//
// Whitespace between <ul> and <li> becomes raw text, so we normalize before
// asserting. The for-loop iterations are concatenated with no separator.
// Expected (normalized): <ul><li>Alpha</li><li>Beta</li></ul>
// ---------------------------------------------------------------------------

Deno.test("post-list: renders b-for loop over items", () => {
    assertEquals(
        normalize(renderRoot(getModule("blog.html")["post_list"], { posts: ["Alpha", "Beta"] })),
        "<ul><li>Alpha</li><li>Beta</li></ul>"
    );
});

Deno.test("post-list: renders empty list", () => {
    assertEquals(
        normalize(renderRoot(getModule("blog.html")["post_list"], { posts: [] })),
        "<ul></ul>"
    );
});

// Template (conditional):
//   <b-unwrap b-name="conditional">
//       <p b-if="show">Shown</p>
//       <p b-else>Hidden</p>
//   </b-unwrap>
//
// Whitespace before/after the <p> tags is trimmed by normalize().
// Expected (normalized): <p>Shown</p> or <p>Hidden</p>

Deno.test("conditional: b-if true branch", () => {
    assertEquals(
        normalize(renderRoot(getModule("blog.html").conditional, { show: true })),
        "<p>Shown</p>"
    );
});

Deno.test("conditional: b-else false branch", () => {
    assertEquals(
        normalize(renderRoot(getModule("blog.html").conditional, { show: false })),
        "<p>Hidden</p>"
    );
});

// ---------------------------------------------------------------------------
// blog.html — b-if / b-for on <b-unwrap>

Deno.test("unwrap-if: b-if true on b-unwrap renders content without wrapper", () => {
    assertEquals(
        normalize(renderRoot(getModule("blog.html").unwrap_if, { show: true })),
        "Visible"
    );
});

Deno.test("unwrap-if: b-else on b-unwrap renders fallback without wrapper", () => {
    assertEquals(
        normalize(renderRoot(getModule("blog.html").unwrap_if, { show: false })),
        "Fallback"
    );
});

Deno.test("unwrap-for: b-for on b-unwrap renders items without wrapper", () => {
    assertEquals(
        normalize(renderRoot(getModule("blog.html").unwrap_for, { items: ["a", "b", "c"] })),
        "a,b,c,"
    );
});

// ---------------------------------------------------------------------------
// ui.html — default slot passing between same-file partials
//
// btn template (compact, no extra whitespace):
//   <button b-name="btn"><b-unwrap b-slot /></button>
//
// demo template:
//   <b-unwrap b-name="demo">
//       <div b-part="#btn">Click me</div>
//   </b-unwrap>
//
// demo renders: wrapper <div> around btn's output, with "Click me" in the slot.
// Expected (normalized): <div><button>Click me</button></div>
// ---------------------------------------------------------------------------

Deno.test("demo: slot content rendered inside btn via b-part", () => {
    assertEquals(
        normalize(renderRoot(getModule("ui.html").demo, {})),
        "<div><button>Click me</button></div>"
    );
});

Deno.test("btn: renders slot content when called directly", () => {
    assertEquals(
        renderRoot(getModule("ui.html").btn, {}, {
            default: { nodes: [{ type: "raw", raw: "Submit" }], ctx: {} }
        }),
        "<button>Submit</button>"
    );
});

Deno.test("btn: renders empty button when no slot content provided", () => {
    assertEquals(renderRoot(getModule("ui.html").btn, {}), "<button></button>");
});

// ---------------------------------------------------------------------------
// ui.html — slot_interp: interpolation inside nested element in slot content
//
// slot_interp template:
//   <b-unwrap b-name="slot_interp">
//       <div b-part="#btn">{{ label }}</div>
//   </b-unwrap>
//
// Expected (normalized): <div><button>Go</button></div>
// ---------------------------------------------------------------------------

Deno.test("slot_interp: interpolated slot content rendered inside btn", () => {
    assertEquals(
        normalize(renderRoot(getModule("ui.html").slot_interp, { label: "Go" })),
        "<div><button>Go</button></div>"
    );
});

Deno.test("slot_for: b-for inside slot content renders loop", () => {
    assertEquals(
        normalize(renderRoot(getModule("ui.html").slot_for, { items: ["A", "B"] })),
        "<div><button><span>A</span><span>B</span></button></div>"
    );
});

Deno.test("slot_for: b-for with empty list renders nothing in slot", () => {
    assertEquals(
        normalize(renderRoot(getModule("ui.html").slot_for, { items: [] })),
        "<div><button></button></div>"
    );
});

Deno.test("slot_if: b-if true branch inside slot content", () => {
    assertEquals(
        normalize(renderRoot(getModule("ui.html").slot_if, { show: true })),
        "<div><button><span>yes</span></button></div>"
    );
});

Deno.test("slot_if: b-else branch inside slot content", () => {
    assertEquals(
        normalize(renderRoot(getModule("ui.html").slot_if, { show: false })),
        "<div><button><span>no</span></button></div>"
    );
});

// ---------------------------------------------------------------------------
// data.html — b-data: passes expressions to partials
//
// badge template:  <b-unwrap b-name="badge">{{ label }}</b-unwrap>
//
// profile template:
//   <b-unwrap b-name="profile">
//       <b-unwrap b-part="#badge" b-data:label="user.name"></b-unwrap>
//   </b-unwrap>
//
// b-data:label="user.name" evaluates user.name in the caller's context and
// binds it as `label` inside the badge partial.
// Expected: "Alice"
// ---------------------------------------------------------------------------

Deno.test("profile: b-data:label passes user.name into badge", () => {
    assertEquals(
        normalize(renderRoot(getModule("data.html").profile, { user: { name: "Alice" } })),
        "Alice"
    );
});

Deno.test("badge: renders label directly when called with context", () => {
    assertEquals(renderRoot(getModule("data.html").badge, { label: "hello" }), "hello");
});

// ---------------------------------------------------------------------------
// Cross-file: page.html references partials defined in components.html
//
// components.html exports:
//   label  — <b-unwrap b-name="label" b-export>{{ text }}</b-unwrap>
//   box    — <b-unwrap b-name="box" b-export>
//                <div class="box"><b-unwrap b-slot /></div>
//            </b-unwrap>
//
// page.html:
//   labeled — includes label from components.html, binds text=msg
//   boxed   — includes box from components.html, passes <span>Hi</span> as slot
//
// The generated page.js contains:  import { label, box } from './components.js'
// We write both .js files to a temp dir and dynamically import() page.js,
// letting the JS module system resolve the cross-file reference.
// ---------------------------------------------------------------------------

Deno.test("cross-file: labeled renders label partial from components.html", () => {
    const mod = crossFileModules.get("page.html")!;
    assertEquals(
        normalize(renderRoot(mod.labeled, { msg: "Hello from components" })),
        "Hello from components"
    );
});

Deno.test("cross-file: boxed renders box partial with slot content from components.html", () => {
    const mod = crossFileModules.get("page.html")!;
    // box wraps slot content in <div class="box">
    // slot content from page.html: <span>Hi</span>
    // Expected (normalized): <div><div class="box"><span>Hi</span></div></div>
    assertEquals(
        normalize(renderRoot(mod.boxed, {})),
        "<div><div class=\"box\"><span>Hi</span></div></div>"
    );
});

Deno.test("cross-file: label partial in components.html renders correctly", () => {
    const mod = crossFileModules.get("components.html")!;
    assertEquals(renderRoot(mod.label, { text: "direct" }), "direct");
});

Deno.test("cross-file: box partial in components.html renders slot content", () => {
    const mod = crossFileModules.get("components.html")!;
    assertEquals(
        normalize(renderRoot(mod.box, {}, {
            default: { nodes: [{ type: "raw", raw: "content" }], ctx: {} }
        })),
        "<div class=\"box\">content</div>"
    );
});

// ---------------------------------------------------------------------------
// binds.html — :attr / b-bind:attr dynamic attribute binding
// ---------------------------------------------------------------------------

Deno.test("attr-bind: checkbox checked=true, disabled=false", () => {
    const mod = getModule("binds.html");
    assertEquals(
        normalize(renderRoot(mod.checkbox, { isChecked: true, isDisabled: false })),
        `<div><input type="checkbox" checked></div>`
    );
});

Deno.test("attr-bind: checkbox checked=false, disabled=true", () => {
    const mod = getModule("binds.html");
    assertEquals(
        normalize(renderRoot(mod.checkbox, { isChecked: false, isDisabled: true })),
        `<div><input type="checkbox" disabled></div>`
    );
});

Deno.test("attr-bind: link with url and cls=false omits class", () => {
    const mod = getModule("binds.html");
    assertEquals(
        normalize(renderRoot(mod.link, { url: "/about", cls: false })),
        `<div><a href="/about">Link</a></div>`
    );
});

Deno.test("attr-bind: link with url and cls string includes class", () => {
    const mod = getModule("binds.html");
    assertEquals(
        normalize(renderRoot(mod.link, { url: "/about", cls: "active" })),
        `<div><a href="/about" class="active">Link</a></div>`
    );
});

Deno.test("attr-bind: XSS in href is escaped", () => {
    const mod = getModule("binds.html");
    const result = renderRoot(mod.link, { url: '"><script>alert(1)</script>', cls: false });
    assertStringIncludes(result, "&quot;");
    assertStringIncludes(result, "&lt;script&gt;");
});

Deno.test("attr-bind: ampersand in class is escaped", () => {
    const mod = getModule("binds.html");
    assertStringIncludes(
        renderRoot(mod.link, { url: "/", cls: "foo & bar" }),
        `class="foo &amp; bar"`
    );
});

Deno.test("attr-bind: mixed static and dynamic attrs preserve source order", () => {
    const mod = getModule("binds.html");
    assertEquals(
        normalize(renderRoot(mod.mixed, { url: "/about", cls: "active" })),
        `<div><a href="/about" id="footer" class="active">Link</a></div>`
    );
});

Deno.test("attr-bind: bind attr on b-name root element renders dynamically", () => {
    const mod = getModule("binds.html");
    assertEquals(
        normalize(renderRoot(mod.root_bind, { cls: "active" })),
        `<div class="active"><span>Content</span></div>`
    );
});

Deno.test("attr-bind: bind attr on b-name root element omits attr when false", () => {
    const mod = getModule("binds.html");
    assertEquals(
        normalize(renderRoot(mod.root_bind, { cls: false })),
        `<div><span>Content</span></div>`
    );
});

// ---------------------------------------------------------------------------
// unary.html — unary operators: !, -, +
// ---------------------------------------------------------------------------

Deno.test("unary: !hidden=false shows Visible", () => {
    assertEquals(
        normalize(renderRoot(getModule("unary.html").negated_if, { hidden: false })),
        "<p>Visible</p>"
    );
});

Deno.test("unary: !hidden=true shows Hidden", () => {
    assertEquals(
        normalize(renderRoot(getModule("unary.html").negated_if, { hidden: true })),
        "<p>Hidden</p>"
    );
});

Deno.test("unary: !hidden with truthy string shows Hidden", () => {
    assertEquals(
        normalize(renderRoot(getModule("unary.html").negated_if, { hidden: "yes" })),
        "<p>Hidden</p>"
    );
});

Deno.test("unary: !hidden with empty string shows Visible", () => {
    assertEquals(
        normalize(renderRoot(getModule("unary.html").negated_if, { hidden: "" })),
        "<p>Visible</p>"
    );
});

Deno.test("unary: !hidden with 0 shows Visible", () => {
    assertEquals(
        normalize(renderRoot(getModule("unary.html").negated_if, { hidden: 0 })),
        "<p>Visible</p>"
    );
});

Deno.test("unary: !hidden with null shows Visible", () => {
    assertEquals(
        normalize(renderRoot(getModule("unary.html").negated_if, { hidden: null })),
        "<p>Visible</p>"
    );
});

Deno.test("unary: !user.blocked member access negation", () => {
    assertEquals(
        normalize(renderRoot(getModule("unary.html").neg_member, { user: { blocked: false } })),
        "<p>Allowed</p>"
    );
});

Deno.test("unary: !user.blocked=true shows Blocked", () => {
    assertEquals(
        normalize(renderRoot(getModule("unary.html").neg_member, { user: { blocked: true } })),
        "<p>Blocked</p>"
    );
});

Deno.test("unary: !!active double negation with truthy value", () => {
    assertEquals(
        normalize(renderRoot(getModule("unary.html").double_neg, { active: "yes" })),
        "<p>Active</p>"
    );
});

Deno.test("unary: !!active double negation with falsy value", () => {
    assertEquals(
        normalize(renderRoot(getModule("unary.html").double_neg, { active: 0 })),
        "<p>Inactive</p>"
    );
});

Deno.test("unary: -offset negates a number", () => {
    assertEquals(
        normalize(renderRoot(getModule("unary.html").minus_print, { offset: 5 })),
        "<span>-5</span>"
    );
});

Deno.test("unary: +value coerces string to number", () => {
    assertEquals(
        normalize(renderRoot(getModule("unary.html").plus_print, { value: "42" })),
        "<span>42</span>"
    );
});
