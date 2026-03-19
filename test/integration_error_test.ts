/**
 * Integration tests for compiler error messages with source locations.
 *
 * Each test compiles an .html file from templates-error/ that contains a single
 * known error and verifies the error message includes the correct filename,
 * line number, and a descriptive message.
 *
 * The compiler aborts on the first error, so each error case lives in its own
 * file / partial.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert";
import { compileFile, BackflipError } from "../compiler/compiler.ts";

const ERROR_DIR = new URL("./templates-error", import.meta.url).pathname;

async function compileErrorFile(filename: string): Promise<BackflipError> {
    const html = await Deno.readTextFile(`${ERROR_DIR}/${filename}`);
    return await assertRejects(() => compileFile(html, undefined, filename), BackflipError);
}

// ---------------------------------------------------------------------------
// bad-for.html — b-for with invalid format
//   line 2: <p b-for="bad format">
// ---------------------------------------------------------------------------

Deno.test("error: b-for with invalid format", async () => {
    const err = await compileErrorFile("bad-for.html");
    assertStringIncludes(err.message, "bad-for.html");
    assertStringIncludes(err.message, 'b-for value must be in the form "item in items"');
    assertEquals(err.line, 2);
});

// ---------------------------------------------------------------------------
// stray-else.html — b-else without a preceding b-if
//   line 2: <p b-else>
// ---------------------------------------------------------------------------

Deno.test("error: stray b-else without b-if", async () => {
    const err = await compileErrorFile("stray-else.html");
    assertStringIncludes(err.message, "stray-else.html");
    assertStringIncludes(err.message, "b-else");
    assertStringIncludes(err.message, "must follow a b-if");
    assertEquals(err.line, 2);
});

// ---------------------------------------------------------------------------
// stray-else-if.html — b-else-if without a preceding b-if
//   line 2: <p b-else-if="y">
// ---------------------------------------------------------------------------

Deno.test("error: stray b-else-if without b-if", async () => {
    const err = await compileErrorFile("stray-else-if.html");
    assertStringIncludes(err.message, "stray-else-if.html");
    assertStringIncludes(err.message, "must follow a b-if");
    assertEquals(err.line, 2);
});

// ---------------------------------------------------------------------------
// else-with-value.html — b-else="y" is not allowed
//   line 3: <p b-else="y">
// ---------------------------------------------------------------------------

Deno.test("error: b-else with a value", async () => {
    const err = await compileErrorFile("else-with-value.html");
    assertStringIncludes(err.message, "else-with-value.html");
    assertStringIncludes(err.message, "b-else should not have a value");
    assertEquals(err.line, 3);
});

// ---------------------------------------------------------------------------
// nested-name.html — b-name inside another b-name
//   line 2: <span b-name="inner">
// ---------------------------------------------------------------------------

Deno.test("error: nested b-name", async () => {
    const err = await compileErrorFile("nested-name.html");
    assertStringIncludes(err.message, "nested-name.html");
    assertStringIncludes(err.message, "b-name is only allowed on top-level elements");
    assertEquals(err.line, 2);
});

// ---------------------------------------------------------------------------
// multiple-b-attrs.html — b-for and b-if on the same element
//   line 2: <p b-for="x in xs" b-if="x">
// ---------------------------------------------------------------------------

Deno.test("error: multiple b-attrs on same element", async () => {
    const err = await compileErrorFile("multiple-b-attrs.html");
    assertStringIncludes(err.message, "multiple-b-attrs.html");
    assertStringIncludes(err.message, "more than one b-attr");
    assertEquals(err.line, 2);
});

// ---------------------------------------------------------------------------
// empty-for-var.html — b-for=" in items" (empty iterator variable)
//   line 2: <p b-for=" in items">
// ---------------------------------------------------------------------------

Deno.test("error: empty b-for variable name", async () => {
    const err = await compileErrorFile("empty-for-var.html");
    assertStringIncludes(err.message, "empty-for-var.html");
    assertStringIncludes(err.message, "bad iter value name");
    assertEquals(err.line, 2);
});
