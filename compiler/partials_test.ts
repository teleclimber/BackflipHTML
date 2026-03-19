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
