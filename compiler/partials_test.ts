// Note: this test file requires --allow-read --allow-write --allow-env flags because it
// creates temporary HTML files in $TMPDIR.
// Run with: deno test --allow-read --allow-write --allow-env compiler/partials_test.ts

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { compileDirectory } from './partials.ts';

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

// Test: regular HTML elements around b-name partials
Deno.test("compileDirectory - regular HTML around partials", async () => {
    const dir = await makeTempDir("html_around");
    await writeFile(path.join(dir, "page.html"), `
        <header>Site Header</header>
        <div b-name="card">
            <p>{{ title }}</p>
        </div>
        <footer>Site Footer</footer>
    `);

    const { directory } = await compileDirectory(dir);
    assertEquals(directory.files.size, 1);
    assertEquals(directory.files.get("page.html")!.partials.size, 1);
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
