// Note: this test file requires --allow-read --allow-write --allow-env flags because it
// creates temporary HTML files in $TMPDIR.
// Run with: deno test --allow-read --allow-write --allow-env compiler/partials_test.ts

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { compileDirectory, scanPartials, validateCustomElementUniqueness } from './partials.ts';
import type { ElementTNode, PartialRegistry, PartialRefTNode, PrintTNode, TNode } from './types.ts';
import { findElement } from './test-helpers.ts';

// Use /tmp/claude-1000/ as the writable temp dir in this sandbox environment.
// Deno.env.get('TMPDIR') may point to a read-only path; /tmp/claude-1000/ is always writable.
const TMPDIR = '/tmp/claude-1000/';

/**
 * Create a temporary directory for a test and return its path.
 */
async function makeTempDir(suffix: string): Promise<string> {
    const dir = path.join(TMPDIR, `partials_test_${suffix}_${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
}

/**
 * Write a file at path (creating parent dirs as needed).
 */
async function writeFile(filePath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
}

// Test: single file with two partials
Deno.test("compileDirectory - single file with two partials", async () => {
    const dir = await makeTempDir("single");
    await writeFile(path.join(dir, "components.html"), `
        <div b-name="header" b-export>
            <h1>Header</h1>
        </div>
        <div b-name="footer" b-export>
            <p>Footer</p>
        </div>
    `);

    const { directory: result } = await compileDirectory(dir);

    assertEquals(result.files.size, 1);
    const compiled = result.files.get("components.html");
    if (!compiled) throw new Error("Expected components.html in result");
    assertEquals(compiled.partials.size, 2);
    assertEquals(compiled.partials.has("header"), true);
    assertEquals(compiled.partials.has("footer"), true);
});

// Test: two files where one cross-file references another (with b-export)
Deno.test("compileDirectory - cross-file reference with b-export", async () => {
    const dir = await makeTempDir("crossfile");

    // provider.html exports a partial
    await writeFile(path.join(dir, "provider.html"), `
        <div b-name="card" b-export>
            <div class="card">card content</div>
        </div>
    `);

    // consumer.html references provider.html#card
    await writeFile(path.join(dir, "consumer.html"), `
        <div b-name="page" b-export>
            <div b-part="provider.html#card"></div>
        </div>
    `);

    const { directory: result } = await compileDirectory(dir);

    assertEquals(result.files.size, 2);
    assertEquals(result.files.has("provider.html"), true);
    assertEquals(result.files.has("consumer.html"), true);

    const consumer = result.files.get("consumer.html")!;
    assertEquals(consumer.partials.has("page"), true);
});

// Test: reports error when a referenced file does not exist in the registry
Deno.test("compileDirectory - reports error when referenced file does not exist", async () => {
    const dir = await makeTempDir("missingfile");

    await writeFile(path.join(dir, "consumer.html"), `
        <div b-name="page" b-export>
            <div b-part="nonexistent.html#card"></div>
        </div>
    `);

    const { errors } = await compileDirectory(dir);
    assertEquals(errors.length > 0, true);
    assertStringIncludes(errors[0].message, 'nonexistent.html');
});

// Test: reports error when a referenced partial exists in a file but is not b-exported
Deno.test("compileDirectory - reports error when referenced partial is not b-exported", async () => {
    const dir = await makeTempDir("notexported");

    // provider.html has "card" partial but WITHOUT b-export
    await writeFile(path.join(dir, "provider.html"), `
        <div b-name="card">
            <div class="card">card content</div>
        </div>
    `);

    // consumer.html tries to reference provider.html#card
    await writeFile(path.join(dir, "consumer.html"), `
        <div b-name="page" b-export>
            <div b-part="provider.html#card"></div>
        </div>
    `);

    const { errors } = await compileDirectory(dir);
    assertEquals(errors.length > 0, true);
    assertStringIncludes(errors[0].message, 'b-export');
});

// Test: reports error when partial name does not exist in referenced file
Deno.test("compileDirectory - reports error when partial does not exist in referenced file", async () => {
    const dir = await makeTempDir("nopartial");

    // provider.html has a "card" partial but NOT "nonexistent"
    await writeFile(path.join(dir, "provider.html"), `
        <div b-name="card" b-export>
            <div class="card">card content</div>
        </div>
    `);

    // consumer.html tries to reference provider.html#nonexistent
    await writeFile(path.join(dir, "consumer.html"), `
        <div b-name="page" b-export>
            <div b-part="provider.html#nonexistent"></div>
        </div>
    `);

    const { errors } = await compileDirectory(dir);
    assertEquals(errors.length > 0, true);
    assertStringIncludes(errors[0].message, 'no partial named "nonexistent" exists in that file');
});

// Test: reports error on circular cross-file dependency (A references B which references A)
Deno.test("compileDirectory - reports error on circular cross-file dependency", async () => {
    const dir = await makeTempDir("circular");

    // a.html references b.html
    await writeFile(path.join(dir, "a.html"), `
        <div b-name="partA" b-export>
            <div b-part="b.html#partB"></div>
        </div>
    `);

    // b.html references a.html (creating a cycle)
    await writeFile(path.join(dir, "b.html"), `
        <div b-name="partB" b-export>
            <div b-part="a.html#partA"></div>
        </div>
    `);

    const { errors } = await compileDirectory(dir);
    assertEquals(errors.length > 0, true);
    assertStringIncludes(errors[0].message, 'Circular dependency');
});

// Test: plain HTML file with no backflip directives
Deno.test("compileDirectory - plain HTML file with no directives", async () => {
    const dir = await makeTempDir("plain");
    await writeFile(path.join(dir, "index.html"), `
        <!DOCTYPE html>
        <html>
        <head><title>Plain Page</title></head>
        <body><h1>Hello World</h1><p>No backflip here.</p></body>
        </html>
    `);

    const { directory, errors } = await compileDirectory(dir);
    assertEquals(directory.files.size, 1);
    const compiled = directory.files.get("index.html")!;
    assertEquals(compiled.partials.size, 0);
});

// Test: empty HTML file
Deno.test("compileDirectory - missing directory compiles to empty, no throw", async () => {
    // A non-existent template directory should yield an empty result rather than
    // throwing ENOENT, so watch-based tools (preview, LSP) can start and pick the
    // directory up once it is created.
    const dir = path.join(TMPDIR, `partials_test_missing_${Date.now()}`);
    const { directory, errors } = await compileDirectory(dir);
    assertEquals(directory.files.size, 0);
    assertEquals(errors.length, 0);
});

Deno.test("compileDirectory - empty HTML file", async () => {
    const dir = await makeTempDir("empty");
    await writeFile(path.join(dir, "empty.html"), "");

    const { directory, errors } = await compileDirectory(dir);
    assertEquals(directory.files.size, 1);
    const compiled = directory.files.get("empty.html")!;
    assertEquals(compiled.partials.size, 0);
});

// Test: HTML file with directives but no b-name (top-level b-for, b-if)
Deno.test("compileDirectory - directives without b-name", async () => {
    const dir = await makeTempDir("no_bname");
    await writeFile(path.join(dir, "page.html"), `
        <ul>
            <li b-for="item of items">{{ item }}</li>
        </ul>
        <div b-if="show">Visible</div>
    `);

    const { directory } = await compileDirectory(dir);
    assertEquals(directory.files.size, 1);
    const compiled = directory.files.get("page.html")!;
    assertEquals(compiled.partials.size, 0);
});

// Test: mix of backflip template and plain HTML files
Deno.test("compileDirectory - mixed backflip and plain HTML files", async () => {
    const dir = await makeTempDir("mixed");
    await writeFile(path.join(dir, "template.html"), `
        <div b-name="card" b-export>
            <div class="card">{{ title }}</div>
        </div>
    `);
    await writeFile(path.join(dir, "plain.html"), `
        <!DOCTYPE html>
        <html><body><p>Just a static page</p></body></html>
    `);

    const { directory } = await compileDirectory(dir);
    assertEquals(directory.files.size, 2);
    assertEquals(directory.files.get("template.html")!.partials.size, 1);
    assertEquals(directory.files.get("plain.html")!.partials.size, 0);
});

// Test: malformed/incomplete HTML
Deno.test("compileDirectory - malformed HTML", async () => {
    const dir = await makeTempDir("malformed");
    await writeFile(path.join(dir, "broken.html"), `
        <div b-name="widget" b-export>
            <p>Unclosed paragraph
            <span>Unclosed span
            <img src="test.png">
        </div>
    `);

    const { directory } = await compileDirectory(dir);
    assertEquals(directory.files.size, 1);
    assertEquals(directory.files.get("broken.html")!.partials.has("widget"), true);
});

// Test: b-part at top level (outside any b-name partial)
Deno.test("compileDirectory - b-part at top level without b-name", async () => {
    const dir = await makeTempDir("toplevel_bpart");
    await writeFile(path.join(dir, "page.html"), `
        <div b-part="card"></div>
    `);

    const { directory } = await compileDirectory(dir);
    assertEquals(directory.files.size, 1);
});

// Test: b-part with content at top level (endTag fires outside partial)
Deno.test("compileDirectory - b-part with content at top level", async () => {
    const dir = await makeTempDir("toplevel_bpart_content");
    await writeFile(path.join(dir, "page.html"), `
        <div b-part="card">
            <p>Some content inside b-part</p>
        </div>
        <p>After b-part</p>
    `);

    const { directory } = await compileDirectory(dir);
    assertEquals(directory.files.size, 1);
});

// Test: regular HTML elements around b-name partials should be errors
Deno.test("compileDirectory - error for regular HTML around partials", async () => {
    const dir = await makeTempDir("html_around");
    await writeFile(path.join(dir, "page.html"), `
        <header>Site Header</header>
        <div b-name="card">
            <p>{{ title }}</p>
        </div>
        <footer>Site Footer</footer>
    `);

    const { directory, errors } = await compileDirectory(dir);
    assertEquals(directory.files.size, 1);
    assertEquals(directory.files.get("page.html")!.partials.size, 1);
    assertEquals(errors.length, 2);
    assertStringIncludes(errors[0].message, 'b-name');
});

// Test: nested b-name (b-name inside another b-name)
Deno.test("compileDirectory - nested b-name", async () => {
    const dir = await makeTempDir("nested_bname");
    await writeFile(path.join(dir, "page.html"), `
        <div b-name="outer">
            <div b-name="inner">
                <p>Nested</p>
            </div>
        </div>
    `);

    const { directory, errors } = await compileDirectory(dir);
    assertEquals(directory.files.size, 1);
});

// Test: b-for and b-if at top level (outside b-name)
Deno.test("compileDirectory - structural directives at top level", async () => {
    const dir = await makeTempDir("toplevel_struct");
    await writeFile(path.join(dir, "page.html"), `
        <div b-for="item of items">
            <p>{{ item }}</p>
        </div>
        <div b-if="show">
            <span>Shown</span>
        </div>
    `);

    const { directory } = await compileDirectory(dir);
    assertEquals(directory.files.size, 1);
});

// Test: HTML with non-HTML files in directory (should be ignored)
Deno.test("compileDirectory - ignores non-HTML files", async () => {
    const dir = await makeTempDir("nonhtml");
    await writeFile(path.join(dir, "style.css"), "body { color: red; }");
    await writeFile(path.join(dir, "script.js"), "console.log('hello');");
    await writeFile(path.join(dir, "data.json"), '{"key": "value"}');
    await writeFile(path.join(dir, "page.html"), `
        <div b-name="page"><p>Content</p></div>
    `);

    const { directory } = await compileDirectory(dir);
    assertEquals(directory.files.size, 1);
    assertEquals(directory.files.has("page.html"), true);
});

// Test: HTML with expressions but no b-name wrapper
Deno.test("compileDirectory - expressions at top level without b-name", async () => {
    const dir = await makeTempDir("toplevel_expr");
    await writeFile(path.join(dir, "page.html"), `
        <h1>{{ title }}</h1>
        <p>{{ description }}</p>
    `);

    const { directory } = await compileDirectory(dir);
    assertEquals(directory.files.size, 1);
});

// Test: b-slot without enclosing b-part
Deno.test("compileDirectory - b-slot without b-part context", async () => {
    const dir = await makeTempDir("orphan_slot");
    await writeFile(path.join(dir, "page.html"), `
        <div b-name="widget">
            <div b-slot="content">Fallback</div>
        </div>
    `);

    const { directory } = await compileDirectory(dir);
    assertEquals(directory.files.size, 1);
});

// Test: HTML files in subdirectories
Deno.test("compileDirectory - files in subdirectories", async () => {
    const dir = await makeTempDir("subdirs");
    await writeFile(path.join(dir, "components", "card.html"), `
        <div b-name="card" b-export><p>{{ title }}</p></div>
    `);
    await writeFile(path.join(dir, "pages", "index.html"), `
        <div b-name="page">
            <div b-part="components/card.html#card" b-data:title="myTitle"></div>
        </div>
    `);

    const { directory } = await compileDirectory(dir);
    assertEquals(directory.files.size, 2);
});

// Test: HTML files in node_modules should be ignored
Deno.test("compileDirectory - ignores node_modules directory", async () => {
    const dir = await makeTempDir("skip_node_modules");
    await writeFile(path.join(dir, "page.html"), `
        <div b-name="page"><p>Hello</p></div>
    `);
    await writeFile(path.join(dir, "node_modules", "some-pkg", "index.html"), `
        <div>Not a backflip file</div>
    `);
    await writeFile(path.join(dir, ".git", "info", "exclude.html"), `
        <div>Not a backflip file</div>
    `);

    const { directory, errors } = await compileDirectory(dir);
    assertEquals(directory.files.size, 1);
    assertEquals(directory.files.has("page.html"), true);
    assertEquals(errors.length, 0);
});

// Test: same-file b-part reference
Deno.test("compileDirectory - same-file b-part reference", async () => {
    const dir = await makeTempDir("samefile");
    await writeFile(path.join(dir, "page.html"), `
        <div b-name="card">
            <div class="card">{{ title }}</div>
        </div>
        <div b-name="page">
            <div b-part="card" b-data:title="myTitle"></div>
        </div>
    `);

    const { directory } = await compileDirectory(dir);
    assertEquals(directory.files.size, 1);
    const compiled = directory.files.get("page.html")!;
    assertEquals(compiled.partials.size, 2);
    assertEquals(compiled.partials.has("card"), true);
    assertEquals(compiled.partials.has("page"), true);
});

// --- Validation: same-file partial not found ---

Deno.test("compileDirectory - error when same-file b-part references non-existent partial", async () => {
    const dir = await makeTempDir("samefile_missing");
    await writeFile(path.join(dir, "page.html"), `
        <div b-name="page">
            <div b-part="#nonexistent"></div>
        </div>
    `);

    const { errors } = await compileDirectory(dir);
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0].message, 'nonexistent');
    assertStringIncludes(errors[0].message, 'not defined');
});

Deno.test("compileDirectory - error when same-file b-part (no hash) references non-existent partial", async () => {
    const dir = await makeTempDir("samefile_missing_nohash");
    await writeFile(path.join(dir, "page.html"), `
        <div b-name="page">
            <div b-part="nonexistent"></div>
        </div>
    `);

    const { errors } = await compileDirectory(dir);
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0].message, 'nonexistent');
    assertStringIncludes(errors[0].message, 'not defined');
});

Deno.test("compileDirectory - error for unresolved b-part includes full attribute range", async () => {
    const dir = await makeTempDir("error_range");
    // Use a single-line file so offsets are predictable
    const content = '<div b-name="page"><div b-part="#missing"></div></div>';
    await writeFile(path.join(dir, "page.html"), content);

    const { errors } = await compileDirectory(dir);
    assertEquals(errors.length, 1);
    // The error should have both start and end location covering the full b-part attribute
    const err = errors[0];
    assertEquals(err.line, 1);
    assertEquals(typeof err.col, 'number');
    assertEquals(typeof err.endLine, 'number');
    assertEquals(typeof err.endCol, 'number');
    // endCol should be greater than col (the range spans the full attribute, not just 1 char)
    assertEquals(err.endCol! > err.col!, true, `endCol (${err.endCol}) should be greater than col (${err.col})`);
});

Deno.test("compileDirectory - no error for valid same-file b-part reference", async () => {
    const dir = await makeTempDir("samefile_valid");
    await writeFile(path.join(dir, "page.html"), `
        <div b-name="card"><p>Card</p></div>
        <div b-name="page">
            <div b-part="#card"></div>
        </div>
    `);

    const { errors } = await compileDirectory(dir);
    assertEquals(errors.length, 0);
});

// --- Validation: b-in referencing non-existent slot ---

Deno.test("compileDirectory - error when b-in references non-existent slot", async () => {
    const dir = await makeTempDir("slot_missing");
    await writeFile(path.join(dir, "page.html"), `
        <div b-name="card">
            <b-unwrap b-slot="title" />
        </div>
        <div b-name="page">
            <b-unwrap b-part="#card">
                <b-unwrap b-in="title">Title</b-unwrap>
                <b-unwrap b-in="footer">Footer</b-unwrap>
            </b-unwrap>
        </div>
    `);

    const { errors } = await compileDirectory(dir);
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0].message, 'footer');
    assertStringIncludes(errors[0].message, 'does not exist');
});

Deno.test("compileDirectory - no error for valid named slot usage", async () => {
    const dir = await makeTempDir("slot_valid");
    await writeFile(path.join(dir, "page.html"), `
        <div b-name="card">
            <b-unwrap b-slot="title" />
            <b-unwrap b-slot="body" />
        </div>
        <div b-name="page">
            <b-unwrap b-part="#card">
                <b-unwrap b-in="title">Title</b-unwrap>
                <b-unwrap b-in="body">Body</b-unwrap>
            </b-unwrap>
        </div>
    `);

    const { errors } = await compileDirectory(dir);
    assertEquals(errors.length, 0);
});

// --- Validation: default slot content without default b-slot ---

Deno.test("compileDirectory - error when default slot content provided but no default slot declared", async () => {
    const dir = await makeTempDir("default_slot_missing");
    await writeFile(path.join(dir, "page.html"), `
        <div b-name="card">
            <b-unwrap b-slot="title" />
        </div>
        <div b-name="page">
            <b-unwrap b-part="#card">
                Default content here
            </b-unwrap>
        </div>
    `);

    const { errors } = await compileDirectory(dir);
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0].message, 'default slot');
    assertStringIncludes(errors[0].message, 'card');
});

Deno.test("compileDirectory - no error when default slot content matches default b-slot", async () => {
    const dir = await makeTempDir("default_slot_valid");
    await writeFile(path.join(dir, "page.html"), `
        <div b-name="card">
            <b-unwrap b-slot />
        </div>
        <div b-name="page">
            <b-unwrap b-part="#card">
                Default content here
            </b-unwrap>
        </div>
    `);

    const { errors } = await compileDirectory(dir);
    assertEquals(errors.length, 0);
});

// --- Validation: cross-file slot validation ---

Deno.test("compileDirectory - error when b-in references non-existent slot in cross-file partial", async () => {
    const dir = await makeTempDir("crossfile_slot_missing");
    await writeFile(path.join(dir, "components.html"), `
        <div b-name="card" b-export>
            <b-unwrap b-slot="title" />
        </div>
    `);
    await writeFile(path.join(dir, "page.html"), `
        <div b-name="page">
            <b-unwrap b-part="components.html#card">
                <b-unwrap b-in="title">Title</b-unwrap>
                <b-unwrap b-in="missing">Oops</b-unwrap>
            </b-unwrap>
        </div>
    `);

    const { errors } = await compileDirectory(dir);
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0].message, 'missing');
    assertStringIncludes(errors[0].message, 'does not exist');
});

Deno.test("compileDirectory - no error for empty b-part (no slot content provided)", async () => {
    const dir = await makeTempDir("empty_bpart");
    await writeFile(path.join(dir, "page.html"), `
        <div b-name="card"><p>Card</p></div>
        <div b-name="page">
            <b-unwrap b-part="#card" />
        </div>
    `);

    const { errors } = await compileDirectory(dir);
    assertEquals(errors.length, 0);
});

// --- scanPartials ---

Deno.test("scanPartials: detects top-level custom element tags", async () => {
    const { defs: found } = await scanPartials('<my-card>content</my-card>', 'page.html');
    assertEquals(found.length, 1);
    assertEquals(found[0].name, 'my-card');
    assertEquals(found[0].exported, false);
    assertEquals(found[0].customElement, true);
    assertEquals(found[0].loc.filename, 'page.html');
});

Deno.test("scanPartials: detects b-export on custom element", async () => {
    const { defs: found } = await scanPartials('<my-card b-export>content</my-card>', 'page.html');
    assertEquals(found.length, 1);
    assertEquals(found[0].name, 'my-card');
    assertEquals(found[0].exported, true);
    assertEquals(found[0].customElement, true);
});

Deno.test("scanPartials: detects top-level b-name partial", async () => {
    const { defs: found } = await scanPartials('<div b-name="hero">x</div>', 'page.html');
    assertEquals(found.length, 1);
    assertEquals(found[0].name, 'hero');
    assertEquals(found[0].exported, false);
    assertEquals(found[0].customElement, false);
});

Deno.test("scanPartials: detects b-export on b-name partial", async () => {
    const { defs: found } = await scanPartials('<div b-name="hero" b-export>x</div>', 'page.html');
    assertEquals(found.length, 1);
    assertEquals(found[0].name, 'hero');
    assertEquals(found[0].exported, true);
    assertEquals(found[0].customElement, false);
});

Deno.test("scanPartials: b-name on a hyphenated tag is a b-name partial, not a custom element", async () => {
    const { defs: found } = await scanPartials('<my-card b-name="foo">x</my-card>', 'page.html');
    assertEquals(found.length, 1);
    assertEquals(found[0].name, 'foo');
    assertEquals(found[0].customElement, false);
});

Deno.test("scanPartials: ignores nested custom elements", async () => {
    const { defs: found } = await scanPartials('<my-outer><my-inner>x</my-inner></my-outer>', 'page.html');
    assertEquals(found.length, 1);
    assertEquals(found[0].name, 'my-outer');
});

Deno.test("scanPartials: ignores nested b-name partials", async () => {
    const { defs: found } = await scanPartials('<div b-name="outer"><span b-name="inner">x</span></div>', 'page.html');
    assertEquals(found.length, 1);
    assertEquals(found[0].name, 'outer');
});

Deno.test("scanPartials: handles multiple top-level definitions of mixed kinds", async () => {
    const { defs: found } = await scanPartials('<my-a>a</my-a><div b-name="b">B</div><my-c>c</my-c>', 'page.html');
    assertEquals(found.length, 3);
    assertEquals(found[0].name, 'my-a');
    assertEquals(found[0].customElement, true);
    assertEquals(found[1].name, 'b');
    assertEquals(found[1].customElement, false);
    assertEquals(found[2].name, 'my-c');
    assertEquals(found[2].customElement, true);
});

Deno.test("scanPartials: ignores b-* directive tags without b-name", async () => {
    const { defs: found } = await scanPartials('<b-unwrap>y</b-unwrap>', 'page.html');
    assertEquals(found.length, 0);
});

Deno.test("scanPartials: ignores plain (non-hyphenated) tags without b-name", async () => {
    const { defs: found } = await scanPartials('<div>y</div>', 'page.html');
    assertEquals(found.length, 0);
});

Deno.test("scanPartials: ignores tags inside HTML comments", async () => {
    const { defs: found } = await scanPartials('<!-- <my-card>x</my-card> --><my-real>y</my-real>', 'page.html');
    assertEquals(found.length, 1);
    assertEquals(found[0].name, 'my-real');
});

Deno.test("scanPartials: ignores '>' inside attribute values", async () => {
    const { defs: found } = await scanPartials('<my-card data-x="a > b">content</my-card>', 'page.html');
    assertEquals(found.length, 1);
    assertEquals(found[0].name, 'my-card');
});

Deno.test("scanPartials: handles self-closing tags", async () => {
    const { defs: found } = await scanPartials('<my-card /><my-other>x</my-other>', 'page.html');
    assertEquals(found.length, 2);
    assertEquals(found[0].name, 'my-card');
    assertEquals(found[1].name, 'my-other');
});

Deno.test("scanPartials: loc.from is opening tag line, loc.to is closing tag line", async () => {
    const html = '\n  <my-card>\n    x\n  </my-card>';
    const { defs: found } = await scanPartials(html, 'page.html');
    assertEquals(found.length, 1);
    assertEquals(found[0].loc.from, 2);
    assertEquals(found[0].loc.to, 4);
});

Deno.test("scanPartials: loc.from === loc.to for self-closing tags", async () => {
    const { defs: found } = await scanPartials('<my-card />', 'page.html');
    assertEquals(found.length, 1);
    assertEquals(found[0].loc.from, 1);
    assertEquals(found[0].loc.to, 1);
});

Deno.test("scanPartials: filename propagates to every def", async () => {
    const { defs: found } = await scanPartials('<my-a></my-a><my-b></my-b>', 'dir/sub.html');
    assertEquals(found.length, 2);
    assertEquals(found[0].loc.filename, 'dir/sub.html');
    assertEquals(found[1].loc.filename, 'dir/sub.html');
});

// --- scanPartials: unnamed top-level element diagnostics ---

Deno.test("scanPartials: error when top-level element lacks b-name in a file with partials", async () => {
    const html = `
		<div b-name="card"><p>Card</p></div>
		<footer>Site Footer</footer>
	`;
    const { errors } = await scanPartials(html, 'page.html');
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0].message, 'b-name');
});

Deno.test("scanPartials: error for multiple top-level elements without b-name", async () => {
    const html = `
		<header>Header</header>
		<div b-name="card"><p>Card</p></div>
		<footer>Footer</footer>
	`;
    const { errors } = await scanPartials(html, 'page.html');
    assertEquals(errors.length, 2);
});

Deno.test("scanPartials: no error when all top-level elements have b-name", async () => {
    const html = `
		<div b-name="header"><h1>Header</h1></div>
		<div b-name="footer"><p>Footer</p></div>
	`;
    const { errors } = await scanPartials(html, 'page.html');
    assertEquals(errors.length, 0);
});

Deno.test("scanPartials: no error when file has top-level elements but no partials", async () => {
    // No partials in the file at all → not a partial file, leave it alone.
    const html = `
		<header>Header</header>
		<footer>Footer</footer>
	`;
    const { errors } = await scanPartials(html, 'page.html');
    assertEquals(errors.length, 0);
});

Deno.test("scanPartials: error includes source location for unnamed top-level element", async () => {
    const html = '<div b-name="card"><p>Card</p></div><span>oops</span>';
    const { errors } = await scanPartials(html, 'test.html');
    assertEquals(errors.length, 1);
    assertEquals(errors[0].filename, 'test.html');
    assertEquals(typeof errors[0].line, 'number');
});

// --- scanPartials: duplicate-name diagnostics ---

Deno.test("scanPartials: duplicate b-name in same file reports error", async () => {
    const { errors } = await scanPartials('<div b-name="card">A</div><div b-name="card">B</div>', 'page.html');
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0].message, 'card');
    assertStringIncludes(errors[0].message, 'already defined');
});

Deno.test("scanPartials: cross-style same-file collision reports error", async () => {
    const { errors } = await scanPartials('<my-card>A</my-card><div b-name="my-card">B</div>', 'page.html');
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0].message, 'my-card');
});

Deno.test("scanPartials: mixing b-name partials and custom element partials in one file", async () => {
    const { defs, errors } = await scanPartials('<div b-name="page">A</div><my-card>B</my-card>', 'page.html');
    assertEquals(errors.length, 0);
    assertEquals(defs.length, 2);
    assertEquals(defs[0].name, 'page');
    assertEquals(defs[0].customElement, false);
    assertEquals(defs[1].name, 'my-card');
    assertEquals(defs[1].customElement, true);
});

// --- validateCustomElementUniqueness ---

const mkDef = (overrides: { name: string; exported: boolean; customElement: boolean; filename: string; from?: number; to?: number }) =>
    ({
        name: overrides.name,
        exported: overrides.exported,
        customElement: overrides.customElement,
        loc: { filename: overrides.filename, from: overrides.from ?? 1, to: overrides.to ?? 1 },
    });

Deno.test("validateCustomElementUniqueness: no error for unique exported", () => {
    const reg: PartialRegistry = new Map([
        ['a.html', [mkDef({ name: 'my-card', exported: true, customElement: true, filename: 'a.html' })]],
        ['b.html', [mkDef({ name: 'my-button', exported: true, customElement: true, filename: 'b.html' })]],
    ]);
    const errors = validateCustomElementUniqueness(reg);
    assertEquals(errors.length, 0);
});

Deno.test("validateCustomElementUniqueness: no error for two unexported with same name", () => {
    const reg: PartialRegistry = new Map([
        ['a.html', [mkDef({ name: 'my-card', exported: false, customElement: true, filename: 'a.html' })]],
        ['b.html', [mkDef({ name: 'my-card', exported: false, customElement: true, filename: 'b.html' })]],
    ]);
    const errors = validateCustomElementUniqueness(reg);
    assertEquals(errors.length, 0);
});

Deno.test("validateCustomElementUniqueness: error when exported name also defined elsewhere unexported", () => {
    const reg: PartialRegistry = new Map([
        ['a.html', [mkDef({ name: 'my-card', exported: true, customElement: true, filename: 'a.html' })]],
        ['b.html', [mkDef({ name: 'my-card', exported: false, customElement: true, filename: 'b.html' })]],
    ]);
    const errors = validateCustomElementUniqueness(reg);
    assertEquals(errors.length > 0, true);
    assertStringIncludes(errors[0].message, 'my-card');
    assertStringIncludes(errors[0].message, 'unique');
});

Deno.test("validateCustomElementUniqueness: error when same name exported in two files", () => {
    const reg: PartialRegistry = new Map([
        ['a.html', [mkDef({ name: 'my-card', exported: true, customElement: true, filename: 'a.html' })]],
        ['b.html', [mkDef({ name: 'my-card', exported: true, customElement: true, filename: 'b.html' })]],
    ]);
    const errors = validateCustomElementUniqueness(reg);
    assertEquals(errors.length > 0, true);
    assertStringIncludes(errors[0].message, 'my-card');
});

// --- compileDirectory: custom element partial resolution ---

Deno.test("compileDirectory - same-file custom element call resolves without error", async () => {
    const dir = await makeTempDir("ce_samefile");
    await writeFile(path.join(dir, "page.html"), `
        <my-notice>Notice!</my-notice>
        <article b-name="post">
            <my-notice></my-notice>
        </article>
    `);
    const { errors } = await compileDirectory(dir);
    assertEquals(errors.filter(e => e.severity !== 'warning').length, 0);
});

Deno.test("compileDirectory - cross-file custom element call resolves with b-export", async () => {
    const dir = await makeTempDir("ce_crossfile");
    await writeFile(path.join(dir, "components.html"), `
        <my-notice b-export>Notice!</my-notice>
    `);
    await writeFile(path.join(dir, "page.html"), `
        <article b-name="post">
            <my-notice></my-notice>
        </article>
    `);
    const { errors } = await compileDirectory(dir);
    const nonWarnings = errors.filter(e => e.severity !== 'warning');
    assertEquals(nonWarnings.length, 0, `unexpected errors: ${JSON.stringify(nonWarnings.map(e => e.message))}`);
});

Deno.test("compileDirectory - unresolved custom element emits warning, no error", async () => {
    const dir = await makeTempDir("ce_unresolved");
    await writeFile(path.join(dir, "page.html"), `
        <article b-name="post">
            <my-typo>Oops</my-typo>
        </article>
    `);
    const { errors } = await compileDirectory(dir);
    const warnings = errors.filter(e => e.severity === 'warning');
    const fatal = errors.filter(e => e.severity !== 'warning');
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0].message, 'my-typo');
    assertEquals(fatal.length, 0);
});

Deno.test("compileDirectory - cross-file custom element without b-export is unresolved", async () => {
    const dir = await makeTempDir("ce_crossfile_noexport");
    await writeFile(path.join(dir, "components.html"), `
        <my-notice>Notice!</my-notice>
    `);
    await writeFile(path.join(dir, "page.html"), `
        <article b-name="post">
            <my-notice></my-notice>
        </article>
    `);
    const { errors } = await compileDirectory(dir);
    const warnings = errors.filter(e => e.severity === 'warning');
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0].message, 'my-notice');
});

Deno.test("compileDirectory - exported custom element conflicts with another definition", async () => {
    const dir = await makeTempDir("ce_uniqueness_violation");
    await writeFile(path.join(dir, "a.html"), `
        <my-card b-export>A</my-card>
    `);
    await writeFile(path.join(dir, "b.html"), `
        <my-card>B</my-card>
    `);
    const { errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    assertEquals(fatal.length > 0, true);
    assertStringIncludes(fatal[0].message, 'my-card');
});

// --- Stage 5: attribute conflict validation ---

Deno.test("compileDirectory - error when caller and definition share an attribute name", async () => {
    const dir = await makeTempDir("ce_attr_conflict");
    await writeFile(path.join(dir, "page.html"), `
        <my-card class="def">A</my-card>
        <article b-name="post">
            <my-card class="caller"></my-card>
        </article>
    `);
    const { errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    assertEquals(fatal.length > 0, true);
    assertStringIncludes(fatal[0].message, 'class');
});

Deno.test("compileDirectory - no error when caller and definition have different attribute names", async () => {
    const dir = await makeTempDir("ce_attr_no_conflict");
    await writeFile(path.join(dir, "page.html"), `
        <my-card data-kind="info">A</my-card>
        <article b-name="post">
            <my-card class="caller"></my-card>
        </article>
    `);
    const { errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    assertEquals(fatal.length, 0, `unexpected: ${JSON.stringify(fatal.map(e => e.message))}`);
});

Deno.test("compileDirectory - bind:foo on caller conflicts with foo on definition", async () => {
    const dir = await makeTempDir("ce_attr_bind_conflict");
    await writeFile(path.join(dir, "page.html"), `
        <my-card title="static">A</my-card>
        <article b-name="post">
            <my-card :title="x"></my-card>
        </article>
    `);
    const { errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    assertEquals(fatal.length > 0, true);
    assertStringIncludes(fatal[0].message, 'title');
});

// --- Stage 2: b-attr validation and binding synthesis ---

/**
 * Helper to find the first PartialRefTNode (custom element call) inside the
 * first partial of a compiled file.
 */
function findFirstPartialRef(tnodes: TNode[]): PartialRefTNode | null {
    for (const n of tnodes) {
        if (n.type === 'partial-ref') return n as PartialRefTNode;
        if (n.type === 'for') {
            const r = findFirstPartialRef((n as { tnodes: TNode[] }).tnodes);
            if (r) return r;
        } else if (n.type === 'if') {
            for (const branch of (n as { branches: { tnodes: TNode[] }[] }).branches) {
                const r = findFirstPartialRef(branch.tnodes);
                if (r) return r;
            }
        } else if (n.type === 'element') {
            const r = findFirstPartialRef((n as { tnodes: TNode[] }).tnodes);
            if (r) return r;
        }
    }
    return null;
}

Deno.test("compileDirectory - b-attr required: omitted at call site is an error", async () => {
    const dir = await makeTempDir("battr_missing");
    await writeFile(path.join(dir, "page.html"), `
        <my-widget b-attr:premium>defn</my-widget>
        <article b-name="post">
            <my-widget></my-widget>
        </article>
    `);
    const { errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    assertEquals(fatal.length > 0, true);
    assertStringIncludes(fatal[0].message, 'premium');
    assertStringIncludes(fatal[0].message, 'not provided');
});

Deno.test("compileDirectory - non-bool b-attr with bare attribute is an error", async () => {
    const dir = await makeTempDir("battr_bare_nonbool");
    await writeFile(path.join(dir, "page.html"), `
        <my-widget b-attr:premium>defn</my-widget>
        <article b-name="post">
            <my-widget premium></my-widget>
        </article>
    `);
    const { errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    assertEquals(fatal.length > 0, true);
    assertStringIncludes(fatal[0].message, 'premium');
    assertStringIncludes(fatal[0].message, 'string value');
});

Deno.test("compileDirectory - bool b-attr with literal string warns", async () => {
    const dir = await makeTempDir("battr_bool_string_warn");
    await writeFile(path.join(dir, "page.html"), `
        <my-widget b-attr:premium.bool>defn</my-widget>
        <article b-name="post">
            <my-widget premium="x"></my-widget>
        </article>
    `);
    const { errors } = await compileDirectory(dir);
    const warnings = errors.filter(e => e.severity === 'warning');
    const fatal = errors.filter(e => e.severity !== 'warning');
    assertEquals(fatal.length, 0, `unexpected fatals: ${JSON.stringify(fatal.map(e => e.message))}`);
    assertEquals(warnings.length >= 1, true);
    assertStringIncludes(warnings.map(w => w.message).join('|'), 'premium');
    assertStringIncludes(warnings.map(w => w.message).join('|'), 'coerced to true');
});

Deno.test("compileDirectory - bool b-attr with empty string also warns", async () => {
    const dir = await makeTempDir("battr_bool_empty_warn");
    await writeFile(path.join(dir, "page.html"), `
        <my-widget b-attr:premium.bool>defn</my-widget>
        <article b-name="post">
            <my-widget premium=""></my-widget>
        </article>
    `);
    const { errors } = await compileDirectory(dir);
    const warnings = errors.filter(e => e.severity === 'warning');
    const fatal = errors.filter(e => e.severity !== 'warning');
    assertEquals(fatal.length, 0, `unexpected fatals: ${JSON.stringify(fatal.map(e => e.message))}`);
    assertEquals(warnings.length >= 1, true);
    assertStringIncludes(warnings.map(w => w.message).join('|'), 'coerced to true');
});

Deno.test("compileDirectory - b-data:NAME conflicts with b-attr:NAME", async () => {
    const dir = await makeTempDir("battr_bdata_conflict");
    await writeFile(path.join(dir, "page.html"), `
        <my-widget b-attr:premium>defn</my-widget>
        <article b-name="post">
            <my-widget premium="ok" b-data:premium="someVar"></my-widget>
        </article>
    `);
    const { errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    assertEquals(fatal.length > 0, true);
    const msgs = fatal.map(e => e.message).join('|');
    assertStringIncludes(msgs, 'b-data:premium');
    assertStringIncludes(msgs, 'b-attr:premium');
});

Deno.test("compileDirectory - synthesized binding: bool bare → literal:true", async () => {
    const dir = await makeTempDir("battr_synth_bool_bare");
    await writeFile(path.join(dir, "page.html"), `
        <my-widget b-attr:premium.bool>defn</my-widget>
        <article b-name="post">
            <my-widget premium></my-widget>
        </article>
    `);
    const { directory, errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    assertEquals(fatal.length, 0, `unexpected fatals: ${JSON.stringify(fatal.map(e => e.message))}`);
    const post = directory.files.get("page.html")!.partials.get("post")!;
    const ref = findFirstPartialRef(post.tnodes);
    if (!ref) throw new Error("no partial-ref");
    const b = ref.bindings.find(b => b.name === 'premium');
    if (!b) throw new Error("no premium binding");
    assertEquals(b.kind, 'literal');
    if (b.kind === 'literal') assertEquals(b.value, true);
});

Deno.test("compileDirectory - synthesized binding: non-bool plain → literal:string", async () => {
    const dir = await makeTempDir("battr_synth_nonbool_plain");
    await writeFile(path.join(dir, "page.html"), `
        <my-widget b-attr:premium>defn</my-widget>
        <article b-name="post">
            <my-widget premium="gold"></my-widget>
        </article>
    `);
    const { directory, errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    assertEquals(fatal.length, 0, `unexpected fatals: ${JSON.stringify(fatal.map(e => e.message))}`);
    const post = directory.files.get("page.html")!.partials.get("post")!;
    const ref = findFirstPartialRef(post.tnodes);
    if (!ref) throw new Error("no partial-ref");
    const b = ref.bindings.find(b => b.name === 'premium');
    if (!b) throw new Error("no premium binding");
    assertEquals(b.kind, 'literal');
    if (b.kind === 'literal') assertEquals(b.value, "gold");
});

Deno.test("compileDirectory - synthesized binding: bool :expr → data + cast:bool", async () => {
    const dir = await makeTempDir("battr_synth_bool_expr");
    await writeFile(path.join(dir, "page.html"), `
        <my-widget b-attr:premium.bool>defn</my-widget>
        <article b-name="post">
            <my-widget :premium="isVip"></my-widget>
        </article>
    `);
    const { directory, errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    assertEquals(fatal.length, 0, `unexpected fatals: ${JSON.stringify(fatal.map(e => e.message))}`);
    const post = directory.files.get("page.html")!.partials.get("post")!;
    const ref = findFirstPartialRef(post.tnodes);
    if (!ref) throw new Error("no partial-ref");
    const b = ref.bindings.find(b => b.name === 'premium');
    if (!b) throw new Error("no premium binding");
    assertEquals(b.kind, 'expr');
    if (b.kind === 'expr') {
        assertEquals(b.cast, 'bool');
        assertEquals(typeof b.data, 'object');
    }
});

Deno.test("compileDirectory - synthesized binding: non-bool :expr → data + cast:string", async () => {
    const dir = await makeTempDir("battr_synth_nonbool_expr");
    await writeFile(path.join(dir, "page.html"), `
        <my-widget b-attr:premium>defn</my-widget>
        <article b-name="post">
            <my-widget :premium="userTier"></my-widget>
        </article>
    `);
    const { directory, errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    assertEquals(fatal.length, 0, `unexpected fatals: ${JSON.stringify(fatal.map(e => e.message))}`);
    const post = directory.files.get("page.html")!.partials.get("post")!;
    const ref = findFirstPartialRef(post.tnodes);
    if (!ref) throw new Error("no partial-ref");
    const b = ref.bindings.find(b => b.name === 'premium');
    if (!b) throw new Error("no premium binding");
    assertEquals(b.kind, 'expr');
    if (b.kind === 'expr') {
        assertEquals(b.cast, 'string');
        assertEquals(typeof b.data, 'object');
    }
});

Deno.test("compileDirectory - bool b-attr called as :expr patches AttrPart.isBoolean", async () => {
    const dir = await makeTempDir("battr_bool_attrpart_patched");
    await writeFile(path.join(dir, "page.html"), `
        <my-widget b-attr:premium.bool>defn</my-widget>
        <article b-name="post">
            <my-widget :premium="isVip"></my-widget>
        </article>
    `);
    const { directory, errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    assertEquals(fatal.length, 0, `unexpected fatals: ${JSON.stringify(fatal.map(e => e.message))}`);
    const post = directory.files.get("page.html")!.partials.get("post")!;
    const ref = findFirstPartialRef(post.tnodes);
    if (!ref || ref.kind !== 'custom-element' || !ref.callerAttrs) throw new Error("no callerAttrs");
    let found = false;
    for (const part of ref.callerAttrs) {
        if (part.type === 'dynamic' && part.name === 'premium') {
            assertEquals(part.isBoolean, true);
            found = true;
        }
    }
    assertEquals(found, true, "expected dynamic AttrPart for premium with isBoolean=true");
});

Deno.test("compileDirectory - cross-file: b-attr validation and synthesis works across files", async () => {
    const dir = await makeTempDir("battr_crossfile");
    await writeFile(path.join(dir, "components.html"), `
        <my-widget b-attr:premium b-attr:checked.bool b-export>
            <p b-if="premium">Premium</p>
        </my-widget>
    `);
    await writeFile(path.join(dir, "page.html"), `
        <article b-name="post" b-export>
            <my-widget premium="gold" :checked="isOn"></my-widget>
        </article>
    `);
    const { directory, errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    assertEquals(fatal.length, 0, `unexpected fatals: ${JSON.stringify(fatal.map(e => e.message))}`);

    const post = directory.files.get("page.html")!.partials.get("post")!;
    const ref = findFirstPartialRef(post.tnodes);
    if (!ref) throw new Error("no partial-ref");
    const premium = ref.bindings.find(b => b.name === 'premium');
    if (!premium) throw new Error("missing premium binding");
    assertEquals(premium.kind, 'literal');
    if (premium.kind === 'literal') assertEquals(premium.value, "gold");
    const checked = ref.bindings.find(b => b.name === 'checked');
    if (!checked) throw new Error("missing checked binding");
    assertEquals(checked.kind, 'expr');
    if (checked.kind === 'expr') {
        assertEquals(checked.cast, 'bool');
        assertEquals(typeof checked.data, 'object');
    }
});

Deno.test("compileDirectory - cross-file: missing required b-attr reports error", async () => {
    const dir = await makeTempDir("battr_crossfile_missing");
    await writeFile(path.join(dir, "components.html"), `
        <my-widget b-attr:premium b-export>defn</my-widget>
    `);
    await writeFile(path.join(dir, "page.html"), `
        <article b-name="post">
            <my-widget></my-widget>
        </article>
    `);
    const { errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    assertEquals(fatal.length > 0, true);
    assertStringIncludes(fatal.map(e => e.message).join('|'), 'premium');
});

Deno.test("compileDirectory - regression: class on both sides still errors when not a b-attr", async () => {
    const dir = await makeTempDir("battr_regression_class");
    await writeFile(path.join(dir, "page.html"), `
        <my-card class="def">A</my-card>
        <article b-name="post">
            <my-card class="caller"></my-card>
        </article>
    `);
    const { errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    assertEquals(fatal.length > 0, true);
    assertStringIncludes(fatal[0].message, 'class');
});

Deno.test("compileDirectory - b-attr-declared name on both sides does NOT trigger conflict error", async () => {
    // Confirms the existing definition/caller name conflict loop excludes b-attr names.
    const dir = await makeTempDir("battr_no_double_flag");
    await writeFile(path.join(dir, "page.html"), `
        <my-widget b-attr:premium>defn</my-widget>
        <article b-name="post">
            <my-widget premium="gold"></my-widget>
        </article>
    `);
    const { errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    assertEquals(fatal.length, 0, `unexpected fatals: ${JSON.stringify(fatal.map(e => e.message))}`);
});

Deno.test("compileDirectory - b-bind:NAME long form behaves like :NAME", async () => {
    const dir = await makeTempDir("battr_bbind_longform");
    await writeFile(path.join(dir, "page.html"), `
        <my-widget b-attr:premium.bool>defn</my-widget>
        <article b-name="post">
            <my-widget b-bind:premium="isVip"></my-widget>
        </article>
    `);
    const { directory, errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    assertEquals(fatal.length, 0, `unexpected fatals: ${JSON.stringify(fatal.map(e => e.message))}`);
    const post = directory.files.get("page.html")!.partials.get("post")!;
    const ref = findFirstPartialRef(post.tnodes);
    if (!ref) throw new Error("no partial-ref");
    const b = ref.bindings.find(b => b.name === 'premium');
    if (!b) throw new Error("no premium binding");
    assertEquals(b.kind, 'expr');
    if (b.kind === 'expr') {
        assertEquals(b.cast, 'bool');
        assertEquals(typeof b.data, 'object');
    }
});

// --- Stage 3: b-attr usage validation in partial body ---

Deno.test("compileDirectory - b-attr used as iterable in body is an error", async () => {
    const dir = await makeTempDir("battr_iterable_error");
    await writeFile(path.join(dir, "page.html"), `
        <my-widget b-attr:items.bool>
            <ul><li b-for="item in items">{{ item }}</li></ul>
        </my-widget>
    `);
    const { errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    assertEquals(fatal.length >= 1, true);
    const msgs = fatal.map(e => e.message).join('|');
    assertStringIncludes(msgs, 'items');
    assertStringIncludes(msgs, 'object/array/iterable');
});

Deno.test("compileDirectory - b-attr used as object (member access) is an error", async () => {
    const dir = await makeTempDir("battr_object_error");
    await writeFile(path.join(dir, "page.html"), `
        <my-widget b-attr:user>
            <p>{{ user.name }}</p>
        </my-widget>
    `);
    const { errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    assertEquals(fatal.length >= 1, true);
    const msgs = fatal.map(e => e.message).join('|');
    assertStringIncludes(msgs, 'user');
    assertStringIncludes(msgs, 'object/array/iterable');
});

Deno.test("compileDirectory - b-attr iterated with elementShape is an error", async () => {
    const dir = await makeTempDir("battr_iter_element_error");
    await writeFile(path.join(dir, "page.html"), `
        <my-widget b-attr:names>
            <ul><li b-for="n in names">{{ n }}</li></ul>
        </my-widget>
    `);
    const { errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    assertEquals(fatal.length >= 1, true);
    assertStringIncludes(fatal.map(e => e.message).join('|'), 'names');
});

Deno.test("compileDirectory - bool b-attr printed in body emits a warning", async () => {
    const dir = await makeTempDir("battr_bool_print_warn");
    await writeFile(path.join(dir, "page.html"), `
        <my-widget b-attr:premium.bool>
            <span>{{ premium }}</span>
        </my-widget>
    `);
    const { errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    const warnings = errors.filter(e => e.severity === 'warning');
    assertEquals(fatal.length, 0, `unexpected fatals: ${JSON.stringify(fatal.map(e => e.message))}`);
    assertEquals(warnings.length >= 1, true);
    const wmsgs = warnings.map(w => w.message).join('|');
    assertStringIncludes(wmsgs, 'premium');
    assertStringIncludes(wmsgs, 'interpolation');
});

Deno.test("compileDirectory - string b-attr printed in body emits no warning or error", async () => {
    const dir = await makeTempDir("battr_string_print_ok");
    await writeFile(path.join(dir, "page.html"), `
        <my-widget b-attr:premium>
            <span>{{ premium }}</span>
        </my-widget>
    `);
    const { errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    const warnings = errors.filter(e => e.severity === 'warning');
    assertEquals(fatal.length, 0, `unexpected fatals: ${JSON.stringify(fatal.map(e => e.message))}`);
    // The only allowable warning is the unresolved-custom-element fallback for
    // `<my-widget>` calls — but here the partial defines it itself, so no warnings.
    const battrWarnings = warnings.filter(w => w.message.includes('premium'));
    assertEquals(battrWarnings.length, 0, `unexpected b-attr warnings: ${JSON.stringify(battrWarnings.map(e => e.message))}`);
});

Deno.test("compileDirectory - string b-attr used as boolean (b-if) emits no warning", async () => {
    const dir = await makeTempDir("battr_string_as_bool_ok");
    await writeFile(path.join(dir, "page.html"), `
        <my-widget b-attr:premium>
            <p b-if="premium">premium content</p>
        </my-widget>
    `);
    const { errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    const warnings = errors.filter(e => e.severity === 'warning');
    assertEquals(fatal.length, 0, `unexpected fatals: ${JSON.stringify(fatal.map(e => e.message))}`);
    const battrWarnings = warnings.filter(w => w.message.includes('premium'));
    assertEquals(battrWarnings.length, 0, `unexpected b-attr warnings: ${JSON.stringify(battrWarnings.map(e => e.message))}`);
});

Deno.test("compileDirectory - bool b-attr used as boolean (b-if) emits no warning (correct usage)", async () => {
    const dir = await makeTempDir("battr_bool_as_bool_ok");
    await writeFile(path.join(dir, "page.html"), `
        <my-widget b-attr:premium.bool>
            <p b-if="premium">premium content</p>
        </my-widget>
    `);
    const { errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    const warnings = errors.filter(e => e.severity === 'warning');
    assertEquals(fatal.length, 0, `unexpected fatals: ${JSON.stringify(fatal.map(e => e.message))}`);
    const battrWarnings = warnings.filter(w => w.message.includes('premium'));
    assertEquals(battrWarnings.length, 0, `unexpected b-attr warnings: ${JSON.stringify(battrWarnings.map(e => e.message))}`);
});

// --- b-data:NAME unknown-name validation ---

Deno.test("compileDirectory - b-data:NAME unknown to same-file b-name partial is an error", async () => {
    const dir = await makeTempDir("bdata_unknown_samefile_bname");
    const content = `<div b-name="card"><h1>{{ title }}</h1></div>\n<div b-name="page"><div b-part="#card" b-data:title="t" b-data:bogus="x"></div></div>\n`;
    await writeFile(path.join(dir, "page.html"), content);
    const { errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    assertEquals(fatal.length, 1, `unexpected fatals: ${JSON.stringify(fatal.map(e => e.message))}`);
    assertStringIncludes(fatal[0].message, 'variable bogus is unused');
    assertStringIncludes(fatal[0].message, '<card>');
    // The error span should cover only the NAME portion of `b-data:bogus`, not the whole tag.
    // Locs are file-relative: the `page` partial starts on file line 2, so the b-data attr
    // is on file line 2. Columns are unchanged by slicing.
    const err = fatal[0];
    assertEquals(err.line, 2);
    const lines = content.split('\n');
    const bogusCol = lines[1].indexOf('b-data:bogus') + 'b-data:'.length + 1; // 1-based
    assertEquals(err.col, bogusCol);
    assertEquals(err.endCol, bogusCol + 'bogus'.length);
});

Deno.test("compileDirectory - b-data:NAME known to same-file b-name partial is OK", async () => {
    const dir = await makeTempDir("bdata_known_samefile_bname");
    await writeFile(path.join(dir, "page.html"), `
        <div b-name="card">
            <h1>{{ title }}</h1>
        </div>
        <div b-name="page">
            <div b-part="#card" b-data:title="t"></div>
        </div>
    `);
    const { errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    assertEquals(fatal.length, 0, `unexpected fatals: ${JSON.stringify(fatal.map(e => e.message))}`);
});

Deno.test("compileDirectory - b-data:NAME unknown to cross-file b-name partial is an error", async () => {
    const dir = await makeTempDir("bdata_unknown_crossfile_bname");
    await writeFile(path.join(dir, "components.html"), `
        <div b-name="card" b-export>
            <h1>{{ title }}</h1>
        </div>
    `);
    await writeFile(path.join(dir, "page.html"), `
        <div b-name="page">
            <div b-part="components.html#card" b-data:title="t" b-data:bogus="x"></div>
        </div>
    `);
    const { errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    assertEquals(fatal.length, 1, `unexpected fatals: ${JSON.stringify(fatal.map(e => e.message))}`);
    assertStringIncludes(fatal[0].message, 'variable bogus is unused');
    assertStringIncludes(fatal[0].message, '<card>');
});

Deno.test("compileDirectory - b-data:NAME unknown to custom element partial is an error", async () => {
    const dir = await makeTempDir("bdata_unknown_custom_element");
    await writeFile(path.join(dir, "page.html"), `
        <my-card>
            <h2>{{ title }}</h2>
        </my-card>
        <article b-name="post">
            <my-card b-data:title="t" b-data:bogus="x"></my-card>
        </article>
    `);
    const { errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    assertEquals(fatal.length, 1, `unexpected fatals: ${JSON.stringify(fatal.map(e => e.message))}`);
    assertStringIncludes(fatal[0].message, 'variable bogus is unused');
    assertStringIncludes(fatal[0].message, '<my-card>');
});

Deno.test("compileDirectory - b-data:NAME known to custom element partial is OK", async () => {
    const dir = await makeTempDir("bdata_known_custom_element");
    await writeFile(path.join(dir, "page.html"), `
        <my-card>
            <h2>{{ title }}</h2>
        </my-card>
        <article b-name="post">
            <my-card b-data:title="t"></my-card>
        </article>
    `);
    const { errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    assertEquals(fatal.length, 0, `unexpected fatals: ${JSON.stringify(fatal.map(e => e.message))}`);
});

Deno.test("compileDirectory - b-data:NAME passed-through to sub-partial is known (not flagged)", async () => {
    // HTML attribute names are lowercased, so the receiving partial must use the
    // lowercased name internally; this test verifies a clean pass-through chain.
    const dir = await makeTempDir("bdata_passthrough");
    await writeFile(path.join(dir, "page.html"), `
        <b-unwrap b-name="badge">{{ label }}</b-unwrap>
        <b-unwrap b-name="profile">
            <b-unwrap b-part="#badge" b-data:label="userlabel"></b-unwrap>
        </b-unwrap>
        <div b-name="page">
            <b-unwrap b-part="#profile" b-data:userlabel="me.name"></b-unwrap>
        </div>
    `);
    const { errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    assertEquals(fatal.length, 0, `unexpected fatals: ${JSON.stringify(fatal.map(e => e.message))}`);
});

Deno.test("compileDirectory - b-data:NAME for b-attr-declared name does not double-error as unknown", async () => {
    // The existing b-data/b-attr conflict error still fires; we should not also
    // emit an "unknown variable" error for the same name.
    const dir = await makeTempDir("bdata_battr_no_double");
    await writeFile(path.join(dir, "page.html"), `
        <my-widget b-attr:premium>defn</my-widget>
        <article b-name="post">
            <my-widget premium="ok" b-data:premium="someVar"></my-widget>
        </article>
    `);
    const { errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    // Exactly one fatal: the b-data/b-attr conflict. No extra "unknown" error.
    const conflictMsgs = fatal.filter(e => e.message.includes('conflicts with b-attr'));
    const unknownMsgs = fatal.filter(e => e.message.includes('is unused in partial'));
    assertEquals(conflictMsgs.length, 1);
    assertEquals(unknownMsgs.length, 0, `unexpected unknown-binding errors: ${JSON.stringify(unknownMsgs.map(e => e.message))}`);
});

Deno.test("compileDirectory - b-data:NAME on unresolved custom element does not error", async () => {
    // Unresolved custom elements fall through as raw HTML and only emit a warning
    // for the unknown tag; we shouldn't add a confusing b-data error on top.
    const dir = await makeTempDir("bdata_unresolved_ce");
    await writeFile(path.join(dir, "page.html"), `
        <article b-name="post">
            <my-typo b-data:foo="x"></my-typo>
        </article>
    `);
    const { errors } = await compileDirectory(dir);
    const fatal = errors.filter(e => e.severity !== 'warning');
    assertEquals(fatal.length, 0, `unexpected fatals: ${JSON.stringify(fatal.map(e => e.message))}`);
});

// --- file-relative source locations (phase 7.3) ---
//
// compileDirectory compiles each partial from a line-sliced chunk of its file;
// every location it emits (errors, AST SourceLocs, root.meta, data-loc strings)
// must be FILE-relative, not slice-relative. These tests pin that for a partial
// that does NOT start on line 1.

// Fixture built line-by-line so expected offsets can be computed from the
// string instead of hand-counted.
const LOC_FIXTURE_LINES = [
    '<div b-name="first">',              // line 1
    '  <p>hello</p>',                    // line 2
    '</div>',                            // line 3
    '<div b-name="second" class="x">',   // line 4  (second partial starts here)
    '  <span>hi</span>',                 // line 5
    '  {{ msg }}',                       // line 6
    '  <p b-if="">bad</p>',              // line 7  (compile error)
    '  <img src~="@bogus/x.png">',       // line 8  (unknown asset directory)
    '</div>',                            // line 9
];
const LOC_FIXTURE = LOC_FIXTURE_LINES.join('\n');

function findPrint(tnodes: TNode[]): PrintTNode | undefined {
    for (const n of tnodes) {
        if (n.type === 'print') return n as PrintTNode;
        if (n.type === 'element') {
            const found = findPrint((n as ElementTNode).tnodes);
            if (found) return found;
        }
    }
    return undefined;
}

function collectStaticAttrRaws(tnodes: TNode[], out: string[] = []): string[] {
    for (const n of tnodes) {
        if (n.type === 'element') {
            for (const a of (n as ElementTNode).attrs) {
                if (a.type === 'static') out.push(a.raw);
            }
            collectStaticAttrRaws((n as ElementTNode).tnodes, out);
        } else if (n.type === 'if') {
            for (const b of n.branches) collectStaticAttrRaws(b.tnodes, out);
        } else if (n.type === 'for') {
            collectStaticAttrRaws(n.tnodes, out);
        }
    }
    return out;
}

async function compileLocFixture() {
    const dir = await makeTempDir("filerel_locs");
    await writeFile(path.join(dir, "page.html"), LOC_FIXTURE);
    return await compileDirectory(dir, {
        includeLocs: true,
        assetMap: new Map([["images", "/img/"]]),
    });
}

Deno.test("compileDirectory - error locations in a second partial are file-relative", async () => {
    const { errors } = await compileLocFixture();

    const bIfErr = errors.find(e => e.message.includes('body has no statements'));
    if (!bIfErr) throw new Error(`b-if error not reported: ${JSON.stringify(errors.map(e => e.message))}`);
    assertEquals(bIfErr.line, 7);
    assertEquals(bIfErr.col, LOC_FIXTURE_LINES[6].indexOf('b-if') + 1);

    const assetErr = errors.find(e => e.message.includes('unknown asset directory'));
    if (!assetErr) throw new Error(`asset error not reported: ${JSON.stringify(errors.map(e => e.message))}`);
    assertEquals(assetErr.line, 8);
    assertEquals(assetErr.col, LOC_FIXTURE_LINES[7].indexOf('@bogus') + 1);
});

Deno.test("compileDirectory - root.loc and root.meta of a second partial are file-relative", async () => {
    const { directory } = await compileLocFixture();
    const root = directory.files.get("page.html")!.partials.get("second")!;

    // root.loc for a b-name partial is the b-name attribute's loc.
    assertEquals(root.loc?.startLine, 4);
    assertEquals(root.loc?.startOffset, LOC_FIXTURE.indexOf('b-name="second"'));

    assertEquals(root.meta?.startLine, 4);
    assertEquals(root.meta?.startOffset, LOC_FIXTURE.indexOf('<div b-name="second"'));
    // The partial's close tag is the last </div> in the file.
    assertEquals(root.meta?.endOffset, LOC_FIXTURE.lastIndexOf('</div>') + '</div>'.length);
});

Deno.test("compileDirectory - element and print locs in a second partial are file-relative", async () => {
    const { directory } = await compileLocFixture();
    const root = directory.files.get("page.html")!.partials.get("second")!;

    const span = findElement(root.tnodes, 'span');
    if (!span) throw new Error("span element not found in second partial");
    assertEquals(span.loc?.startLine, 5);
    assertEquals(span.loc?.startOffset, LOC_FIXTURE.indexOf('<span>'));
    assertEquals(span.loc?.endOffset, LOC_FIXTURE.indexOf('</span>') + '</span>'.length);

    const print = findPrint(root.tnodes);
    if (!print) throw new Error("print node not found in second partial");
    assertEquals(print.loc?.startLine, 6);
    assertEquals(print.loc?.startOffset, LOC_FIXTURE.indexOf('{{ msg }}'));
});

Deno.test("compileDirectory - asset ref locs in a second partial are file-relative", async () => {
    const lines = [
        '<div b-name="first">x</div>',       // line 1
        '<div b-name="second">',             // line 2
        '  <img src~="@images/ok.png">',     // line 3
        '</div>',                            // line 4
    ];
    const html = lines.join('\n');
    const dir = await makeTempDir("filerel_assetref");
    await writeFile(path.join(dir, "page.html"), html);
    const { directory, errors } = await compileDirectory(dir, { assetMap: new Map([["images", "/img/"]]) });
    assertEquals(errors.length, 0, `unexpected errors: ${JSON.stringify(errors.map(e => e.message))}`);

    const root = directory.files.get("page.html")!.partials.get("second")!;
    const img = findElement(root.tnodes, 'img');
    if (!img) throw new Error("img element not found in second partial");
    const assetPart = img.attrs.find(a => a.type === 'asset');
    if (!assetPart || assetPart.type !== 'asset') throw new Error("asset AttrPart not found on img");

    const ref = assetPart.refs[0];
    assertEquals(ref.loc?.startLine, 3);
    assertEquals(ref.loc?.startOffset, html.indexOf('@images/ok.png'));
    assertEquals(ref.loc?.endOffset, html.indexOf('@images/ok.png') + '@images/ok.png'.length);
    assertEquals(ref.subpathLoc?.startLine, 3);
    assertEquals(ref.subpathLoc?.startOffset, html.indexOf('ok.png'));
});

Deno.test("compileDirectory - multi-line srcset~ ref locs in a second partial are file-relative", async () => {
    const lines = [
        '<div b-name="first">x</div>',       // line 1
        '<div b-name="second">',             // line 2
        '  <img srcset~="@images/a.png 1x,', // line 3
        '    @images/b.png 2x">',            // line 4
        '</div>',                            // line 5
    ];
    const html = lines.join('\n');
    const dir = await makeTempDir("filerel_srcset");
    await writeFile(path.join(dir, "page.html"), html);
    const { directory, errors } = await compileDirectory(dir, { assetMap: new Map([["images", "/img/"]]) });
    assertEquals(errors.length, 0, `unexpected errors: ${JSON.stringify(errors.map(e => e.message))}`);

    const root = directory.files.get("page.html")!.partials.get("second")!;
    const img = findElement(root.tnodes, 'img');
    if (!img) throw new Error("img element not found in second partial");
    const assetPart = img.attrs.find(a => a.type === 'asset');
    if (!assetPart || assetPart.type !== 'asset') throw new Error("asset AttrPart not found on img");

    const [refA, refB] = assetPart.refs;
    assertEquals(refA.loc?.startLine, 3);
    assertEquals(refA.loc?.startCol, lines[2].indexOf('@images/a.png') + 1);
    assertEquals(refA.loc?.startOffset, html.indexOf('@images/a.png'));
    assertEquals(refA.subpathLoc?.startOffset, html.indexOf('a.png'));
    assertEquals(refB.loc?.startLine, 4);
    assertEquals(refB.loc?.startCol, lines[3].indexOf('@images/b.png') + 1);
    assertEquals(refB.loc?.startOffset, html.indexOf('@images/b.png'));
    assertEquals(refB.loc?.endOffset, html.indexOf('@images/b.png') + '@images/b.png'.length);
    assertEquals(refB.subpathLoc?.startLine, 4);
    assertEquals(refB.subpathLoc?.startOffset, html.indexOf('b.png'));
});

Deno.test("compileDirectory - data-loc strings in a second partial are file-relative", async () => {
    const { directory } = await compileLocFixture();
    const root = directory.files.get("page.html")!.partials.get("second")!;

    const raws = collectStaticAttrRaws(root.tnodes).join('');
    const locs = [...raws.matchAll(/data-loc="([^"]*)"/g)].map(m => m[1]).sort();
    // One data-loc per element of the second partial, each at its file line:col.
    assertEquals(locs, [
        'page.html#second:4:1',   // <div b-name="second">
        'page.html#second:5:3',   // <span>
        'page.html#second:7:3',   // <p b-if="">
        'page.html#second:8:3',   // <img>
    ]);
});
