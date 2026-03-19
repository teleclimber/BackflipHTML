/**
 * Integration tests for compiler error collection with source locations.
 *
 * Compiles the templates-error/ directory (which contains multiple files, each
 * with multiple errors) via compileDirectory and verifies that every expected
 * error is reported with the correct filename, line number, and message.
 */

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { compileDirectory } from "../compiler/partials.ts";
import { BackflipError } from "../compiler/compiler.ts";

const ERROR_DIR = new URL("./templates-error", import.meta.url).pathname;

const { errors } = await compileDirectory(ERROR_DIR);

/** Find all errors whose filename matches the given name. */
function errorsFor(filename: string): BackflipError[] {
    return errors.filter(e => e.filename === filename);
}

/** Find the error matching a filename and a message substring. */
function findError(filename: string, messagePart: string): BackflipError {
    const match = errors.find(
        e => e.filename === filename && e.message.includes(messagePart)
    );
    if (!match) {
        const available = errorsFor(filename).map(e => e.message).join("\n  ");
        throw new Error(
            `No error in "${filename}" matching "${messagePart}".\nAvailable errors:\n  ${available || "(none)"}`
        );
    }
    return match;
}

// ---------------------------------------------------------------------------
// for-errors.html
//   line 2: <p b-for="bad format">       — bad b-for syntax
//   line 3: <p b-for=" in items">        — empty iter variable
// ---------------------------------------------------------------------------

Deno.test("for-errors.html: reports 2 errors", () => {
    assertEquals(errorsFor("for-errors.html").length, 2);
});

Deno.test("for-errors.html: bad b-for syntax at line 2", () => {
    const err = findError("for-errors.html", 'b-for value must be in the form "item in items"');
    assertEquals(err.line, 2);
});

Deno.test("for-errors.html: empty iter variable at line 3", () => {
    const err = findError("for-errors.html", "bad iter value name");
    assertEquals(err.line, 3);
});

// ---------------------------------------------------------------------------
// conditional-errors.html
//   line 2: <p b-else>                   — stray b-else
//   line 3: <p b-else-if="y">            — stray b-else-if
//   line 5: <p b-else="y">               — b-else with a value
// ---------------------------------------------------------------------------

Deno.test("conditional-errors.html: reports 3 errors", () => {
    assertEquals(errorsFor("conditional-errors.html").length, 3);
});

Deno.test("conditional-errors.html: stray b-else at line 2", () => {
    const err = findError("conditional-errors.html", "must follow a b-if");
    assertEquals(err.line, 2);
    assertStringIncludes(err.message, "b-else");
});

Deno.test("conditional-errors.html: stray b-else-if at line 3", () => {
    const errs = errorsFor("conditional-errors.html").filter(
        e => e.message.includes("must follow a b-if")
    );
    const elseIf = errs.find(e => e.line === 3);
    assertEquals(elseIf !== undefined, true, "expected stray b-else-if error at line 3");
});

Deno.test("conditional-errors.html: b-else with value at line 5", () => {
    const err = findError("conditional-errors.html", "b-else should not have a value");
    assertEquals(err.line, 5);
});

// ---------------------------------------------------------------------------
// structural-errors.html
//   line 2: <span b-name="inner">        — nested b-name
//   line 3: <p b-for="x in xs" b-if="x"> — multiple b-attrs
// ---------------------------------------------------------------------------

Deno.test("structural-errors.html: reports 2 errors", () => {
    assertEquals(errorsFor("structural-errors.html").length, 2);
});

Deno.test("structural-errors.html: nested b-name at line 2", () => {
    const err = findError("structural-errors.html", "b-name is only allowed on top-level elements");
    assertEquals(err.line, 2);
});

Deno.test("structural-errors.html: multiple b-attrs at line 3", () => {
    const err = findError("structural-errors.html", "more than one b-attr");
    assertEquals(err.line, 3);
});

// ---------------------------------------------------------------------------
// All files combined: verify total error count across the directory
// ---------------------------------------------------------------------------

Deno.test("total errors across all files", () => {
    assertEquals(errors.length, 7);
});
