/**
 * End-to-end integration tests: compile templates → generate PHP → render HTML via PHP CLI.
 *
 * Pipeline: compileDirectory → fileToPhpFile → write .php to temp dir →
 *           run PHP harness script → assert stdout matches expected HTML.
 *
 * Mirrors integration_test.ts exactly: same templates, same contexts, same expected outputs.
 */

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { compileDirectory } from "../compiler/partials.ts";
import { fileToPhpFile } from "../compiler/generate/php/nodes2php.ts";

const TEMPLATES_DIR = new URL("./templates", import.meta.url).pathname;
const TMPDIR = "/tmp/claude-1000/integration-php-test-output";
const RENDER_PHP = new URL("../runtime/php/render.php", import.meta.url).pathname;

// Compile once for all tests
const { directory: compiled } = await compileDirectory(TEMPLATES_DIR);

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

Deno.test("php: greeting: escapes HTML in interpolated value", async () => {
    assertStringIncludes(
        await renderPhp("simple.html", "greeting", { name: "<script>alert(1)</script>" }),
        "&lt;script&gt;alert(1)&lt;/script&gt;"
    );
});

Deno.test("php: greeting: renders with a different name", async () => {
    assertEquals(
        await renderPhp("simple.html", "greeting", { name: "Alice" }),
        "<p>Hello, Alice!</p>"
    );
});

Deno.test("php: comment node renders verbatim as an HTML comment", async () => {
    const root = `['type' => 'root', 'nodes' => [`
        + `['type' => 'raw', 'raw' => '<p>a'],`
        + `['type' => 'comment', 'text' => 'bfid:bf1'],`
        + `['type' => 'raw', 'raw' => 'b</p>']`
        + `]]`;
    const script = `<?php
declare(strict_types=1);
require '${RENDER_PHP}';
echo backflip_renderRoot(${root}, []);
`;
    assertEquals(await runPhp(script), "<p>a<!--bfid:bf1-->b</p>");
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

// ---------------------------------------------------------------------------
// custom-elements.html — partials defined and called via custom element tags.
// ---------------------------------------------------------------------------

Deno.test("php: custom-element: bare call renders single merged tag with definition attrs", async () => {
    assertEquals(
        normalize(await renderPhp("custom-elements.html", "caller_simple", {})),
        '<my-notice class="notice">Notice!</my-notice>'
    );
});

Deno.test("php: custom-element: caller attrs are merged before definition attrs", async () => {
    assertEquals(
        normalize(await renderPhp("custom-elements.html", "caller_with_attr", {})),
        '<my-notice id="hi" class="notice">Notice!</my-notice>'
    );
});

Deno.test("php: custom-element: b-data binding evaluated in caller ctx, used in def body", async () => {
    assertEquals(
        normalize(await renderPhp("custom-elements.html", "caller_card", { heading: "Hi", body: "Lorem" })),
        '<my-card class="card"><h2>Hi</h2><div class="body"><p>Lorem</p></div></my-card>'
    );
});

Deno.test("php: custom-element: print interpolation inside body resolves in childCtx", async () => {
    assertEquals(
        normalize(await renderPhp("custom-elements.html", "caller_greeting", { who: "Ada" })),
        "<my-greeting>Hello, Ada!</my-greeting>"
    );
});

Deno.test("php: custom-element: dynamic caller attr (:data-id) evaluates in caller ctx", async () => {
    assertEquals(
        normalize(await renderPhp("custom-elements.html", "caller_dyn_attr", { ident: 42 })),
        '<my-notice data-id="42" class="notice">Notice!</my-notice>'
    );
});

Deno.test("php: custom-element: call inside b-unwrap b-for loops correctly", async () => {
    assertEquals(
        normalize(await renderPhp("custom-elements.html", "caller_in_for", { names: ["Ada", "Bob"] })),
        "<my-greeting>Hello, Ada!</my-greeting><my-greeting>Hello, Bob!</my-greeting>"
    );
});

Deno.test("php: custom-element: call inside b-unwrap b-if rendered when condition true", async () => {
    assertEquals(
        normalize(await renderPhp("custom-elements.html", "caller_conditional", { show: true })),
        '<my-notice class="notice">Notice!</my-notice>'
    );
});

Deno.test("php: custom-element: b-else branch renders when condition false", async () => {
    assertEquals(
        normalize(await renderPhp("custom-elements.html", "caller_conditional", { show: false })),
        "nothing"
    );
});

Deno.test("php: custom-element: unknown tag falls back to plain HTML", async () => {
    assertEquals(
        normalize(await renderPhp("custom-elements.html", "caller_unknown", {})),
        '<fancy-widget data-x="1">inside</fancy-widget>'
    );
});

// ---------------------------------------------------------------------------
// battr.html — b-attr:* declared on custom element partial definitions
// ---------------------------------------------------------------------------

Deno.test("php: b-attr: :premium=true sets childCtx and renders bare premium", async () => {
    const html = normalize(await renderPhp("battr.html", "caller_premium_true", {}));
    assertStringIncludes(html, "<span>PRO</span>");
    assertStringIncludes(html, "<my-widget premium");
});

Deno.test("php: b-attr: :premium=false sets childCtx and suppresses premium attr", async () => {
    const html = normalize(await renderPhp("battr.html", "caller_premium_false", {}));
    assertStringIncludes(html, "<span>FREE</span>");
    assertEquals(html.includes(" premium"), false);
});

Deno.test("php: b-attr: :premium=expr evaluates in caller ctx with bool cast", async () => {
    const html = normalize(await renderPhp("battr.html", "caller_premium_expr", { isPro: true }));
    assertStringIncludes(html, "<span>PRO</span>");
    const html2 = normalize(await renderPhp("battr.html", "caller_premium_expr", { isPro: 0 }));
    assertStringIncludes(html2, "<span>FREE</span>");
});

Deno.test("php: b-attr: literal string label arrives as-is in childCtx", async () => {
    const html = normalize(await renderPhp("battr.html", "caller_label_literal", {}));
    assertStringIncludes(html, "<em>hello</em>");
});

Deno.test("php: b-attr: expression label is cast to string in childCtx", async () => {
    const html = normalize(await renderPhp("battr.html", "caller_label_expr", { answer: 42 }));
    assertStringIncludes(html, "<em>42</em>");
});

Deno.test("php: b-attr: bare premium attribute synthesizes literal=true binding", async () => {
    const html = normalize(await renderPhp("battr.html", "caller_premium_bare", {}));
    assertStringIncludes(html, "<span>PRO</span>");
});

Deno.test("php: custom-element: cross-file exported partial is callable from another file", async () => {
    assertEquals(
        normalize(await renderPhp("ce-consumer.html", "cross_file_card", { heading: "Hi", body: "Lorem" })),
        '<my-card class="card"><h2>Hi</h2><div class="body"><em>Lorem</em></div></my-card>'
    );
});

// ---------------------------------------------------------------------------
// binds.html — :attr / b-bind:attr dynamic attribute binding
// ---------------------------------------------------------------------------

Deno.test("php: attr-bind: checkbox checked=true, disabled=false", async () => {
    assertEquals(
        normalize(await renderPhp("binds.html", "checkbox", { isChecked: true, isDisabled: false })),
        `<div><input type="checkbox" checked></div>`
    );
});

Deno.test("php: attr-bind: checkbox checked=false, disabled=true", async () => {
    assertEquals(
        normalize(await renderPhp("binds.html", "checkbox", { isChecked: false, isDisabled: true })),
        `<div><input type="checkbox" disabled></div>`
    );
});

Deno.test("php: static attrs: bare attrs stay bare, explicit empty values are kept", async () => {
    assertEquals(
        normalize(await renderPhp("binds.html", "static_bare", { v: "x" })),
        `<div><input type="checkbox" checked><input disabled value="x"><input readonly=""></div>`
    );
});

Deno.test("php: static attrs: source quoting is preserved verbatim", async () => {
    assertEquals(
        normalize(await renderPhp("binds.html", "static_quotes", { v: "x" })),
        `<div><a href='single' title="double" data-bare=unquoted data-mixed='say "hi"' data-amp="a &amp; b" class='' id="x">Link</a></div>`
    );
});

Deno.test("php: attr-bind: link with url and cls=false omits class", async () => {
    assertEquals(
        normalize(await renderPhp("binds.html", "link", { url: "/about", cls: false })),
        `<div><a href="/about">Link</a></div>`
    );
});

Deno.test("php: attr-bind: link with url and cls string includes class", async () => {
    assertEquals(
        normalize(await renderPhp("binds.html", "link", { url: "/about", cls: "active" })),
        `<div><a href="/about" class="active">Link</a></div>`
    );
});

Deno.test("php: attr-bind: XSS in href is escaped", async () => {
    const result = await renderPhp("binds.html", "link", { url: '"><script>alert(1)</script>', cls: false });
    assertStringIncludes(result, "&quot;");
    assertStringIncludes(result, "&lt;script&gt;");
});

Deno.test("php: attr-bind: ampersand in class is escaped", async () => {
    assertStringIncludes(
        await renderPhp("binds.html", "link", { url: "/", cls: "foo & bar" }),
        `class="foo &amp; bar"`
    );
});

// ---------------------------------------------------------------------------
// unary.html — unary operators: !, -, +
// ---------------------------------------------------------------------------

Deno.test("php: unary: !hidden=false shows Visible", async () => {
    assertEquals(
        normalize(await renderPhp("unary.html", "negated_if", { hidden: false })),
        "<p>Visible</p>"
    );
});

Deno.test("php: unary: !hidden=true shows Hidden", async () => {
    assertEquals(
        normalize(await renderPhp("unary.html", "negated_if", { hidden: true })),
        "<p>Hidden</p>"
    );
});

Deno.test("php: unary: !hidden with truthy string shows Hidden", async () => {
    assertEquals(
        normalize(await renderPhp("unary.html", "negated_if", { hidden: "yes" })),
        "<p>Hidden</p>"
    );
});

Deno.test("php: unary: !hidden with empty string shows Visible", async () => {
    assertEquals(
        normalize(await renderPhp("unary.html", "negated_if", { hidden: "" })),
        "<p>Visible</p>"
    );
});

Deno.test("php: unary: !hidden with 0 shows Visible", async () => {
    assertEquals(
        normalize(await renderPhp("unary.html", "negated_if", { hidden: 0 })),
        "<p>Visible</p>"
    );
});

Deno.test("php: unary: !hidden with null shows Visible", async () => {
    assertEquals(
        normalize(await renderPhp("unary.html", "negated_if", { hidden: null })),
        "<p>Visible</p>"
    );
});

Deno.test("php: unary: !user.blocked member access negation", async () => {
    assertEquals(
        normalize(await renderPhp("unary.html", "neg_member", { user: { blocked: false } })),
        "<p>Allowed</p>"
    );
});

Deno.test("php: unary: !user.blocked=true shows Blocked", async () => {
    assertEquals(
        normalize(await renderPhp("unary.html", "neg_member", { user: { blocked: true } })),
        "<p>Blocked</p>"
    );
});

Deno.test("php: unary: !!active double negation with truthy value", async () => {
    assertEquals(
        normalize(await renderPhp("unary.html", "double_neg", { active: "yes" })),
        "<p>Active</p>"
    );
});

Deno.test("php: unary: !!active double negation with falsy value", async () => {
    assertEquals(
        normalize(await renderPhp("unary.html", "double_neg", { active: 0 })),
        "<p>Inactive</p>"
    );
});

Deno.test("php: unary: -offset negates a number", async () => {
    assertEquals(
        normalize(await renderPhp("unary.html", "minus_print", { offset: 5 })),
        "<span>-5</span>"
    );
});

Deno.test("php: unary: +value coerces string to number", async () => {
    assertEquals(
        normalize(await renderPhp("unary.html", "plus_print", { value: "42" })),
        "<span>42</span>"
    );
});

// ---------------------------------------------------------------------------
// ternary.html — conditional (ternary) operator
// ---------------------------------------------------------------------------

Deno.test("php: ternary: print true branch", async () => {
    assertEquals(
        normalize(await renderPhp("ternary.html", "print_ternary", { flag: true })),
        "<span>on</span>"
    );
});

Deno.test("php: ternary: print false branch", async () => {
    assertEquals(
        normalize(await renderPhp("ternary.html", "print_ternary", { flag: false })),
        "<span>off</span>"
    );
});

Deno.test("php: ternary: member access in test and consequent", async () => {
    assertEquals(
        normalize(await renderPhp("ternary.html", "member_ternary", { user: { admin: true, name: "Ada" } })),
        "<span>Ada</span>"
    );
    assertEquals(
        normalize(await renderPhp("ternary.html", "member_ternary", { user: { admin: false, name: "Ada" } })),
        "<span>guest</span>"
    );
});

Deno.test("php: ternary: in attribute binding picks consequent", async () => {
    assertEquals(
        normalize(await renderPhp("ternary.html", "attr_ternary", { isExternal: true, extUrl: "https://x", intUrl: "/y" })),
        '<a href="https://x">link</a>'
    );
});

Deno.test("php: ternary: in attribute binding picks alternate", async () => {
    assertEquals(
        normalize(await renderPhp("ternary.html", "attr_ternary", { isExternal: false, extUrl: "https://x", intUrl: "/y" })),
        '<a href="/y">link</a>'
    );
});

Deno.test("php: ternary: nested ternary picks middle branch", async () => {
    assertEquals(
        normalize(await renderPhp("ternary.html", "nested_ternary", { a: false, b: true })),
        "<span>B</span>"
    );
});

Deno.test("php: ternary: nested ternary picks last branch", async () => {
    assertEquals(
        normalize(await renderPhp("ternary.html", "nested_ternary", { a: false, b: false })),
        "<span>C</span>"
    );
});

// ---------------------------------------------------------------------------
// plus.html — + operator (numeric addition and string concatenation)
// ---------------------------------------------------------------------------

Deno.test("php: plus: numeric addition", async () => {
    assertEquals(
        normalize(await renderPhp("plus.html", "numeric_plus", { a: 2, b: 3 })),
        "<span>5</span>"
    );
});

Deno.test("php: plus: string concatenation", async () => {
    assertEquals(
        normalize(await renderPhp("plus.html", "string_concat", { first: "Ada", last: " Lovelace" })),
        "<span>Ada Lovelace</span>"
    );
});

Deno.test("php: plus: literal prefix on var", async () => {
    assertEquals(
        normalize(await renderPhp("plus.html", "literal_plus_var", { name: "Ada" })),
        "<span>Hello, Ada</span>"
    );
});

Deno.test("php: plus: member access concat", async () => {
    assertEquals(
        normalize(await renderPhp("plus.html", "member_plus", { user: { first: "Ada", last: " Lovelace" } })),
        "<span>Ada Lovelace</span>"
    );
});

Deno.test("php: plus: chained string concat", async () => {
    assertEquals(
        normalize(await renderPhp("plus.html", "chained_plus", { a: "x", b: "y", c: "z" })),
        "<span>xyz</span>"
    );
});

Deno.test("php: plus: chained numeric", async () => {
    assertEquals(
        normalize(await renderPhp("plus.html", "chained_plus", { a: 1, b: 2, c: 3 })),
        "<span>6</span>"
    );
});

Deno.test("php: plus: in attribute binding", async () => {
    assertEquals(
        normalize(await renderPhp("plus.html", "attr_plus", { id: 42 })),
        '<a href="/users/42">link</a>'
    );
});

// ---------------------------------------------------------------------------
// forwarding.html — slot forwarding (mirrors integration_test.ts)
// ---------------------------------------------------------------------------

Deno.test("php forwarding: named slot forwards into the callee's named slot", async () => {
    assertEquals(
        normalize(await renderPhp("forwarding.html", "page_named", {})),
        "<div><div><div>[PAYLOAD]</div></div></div>"
    );
});

Deno.test("php forwarding: named slot forwards into the callee's default slot", async () => {
    assertEquals(
        normalize(await renderPhp("forwarding.html", "page_default", {})),
        "<div><div><div>[PAYLOAD]</div></div></div>"
    );
});

Deno.test("php forwarding: the enclosing partial's default slot forwards into a named slot", async () => {
    assertEquals(
        normalize(await renderPhp("forwarding.html", "page_from_default", {})),
        "<div><div><div>[PAYLOAD]</div></div></div>"
    );
});

Deno.test("php forwarding: a real tag carrying the forward wraps the injected content", async () => {
    assertEquals(
        normalize(await renderPhp("forwarding.html", "page_wrapped", {})),
        '<div><div><div>[<span class="w">PAYLOAD</span>]</div></div></div>'
    );
});

Deno.test("php forwarding: body of a forwarded b-slot follows the injected content", async () => {
    assertEquals(
        normalize(await renderPhp("forwarding.html", "page_with_body", {})),
        "<div><div><div>[PAYLOAD|tail]</div></div></div>"
    );
});

Deno.test("php forwarding: a slot declared both normally and as a forward fills both places", async () => {
    assertEquals(
        normalize(await renderPhp("forwarding.html", "page_twice", {})),
        "<div><div><div>[PAYLOAD]</div></div><em>PAYLOAD</em></div>"
    );
});

Deno.test("php forwarding: works through a custom element call", async () => {
    assertEquals(
        normalize(await renderPhp("forwarding.html", "page_custom", {})),
        "<div><fwd-card>[card:PAYLOAD]</fwd-card></div>"
    );
});

Deno.test("php forwarding: chains through two levels of partials", async () => {
    assertEquals(
        normalize(await renderPhp("forwarding.html", "page_chained", {})),
        "<div><div><div><div>[PAYLOAD]</div></div></div></div>"
    );
});

Deno.test("php forwarding: forwarded slot content is evaluated in the caller's context", async () => {
    assertEquals(
        normalize(await renderPhp("forwarding.html", "page_scope", { who: "Ada" })),
        "<div><div><div>[Ada]</div></div></div>"
    );
});

Deno.test("php forwarding: b-data on the call does not leak into forwarded slot content", async () => {
    assertEquals(
        normalize(await renderPhp("forwarding.html", "page_shadowing", { who: "caller" })),
        "<div><div><div>[child:caller]</div></div></div>"
    );
});
