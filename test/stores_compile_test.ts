/**
 * Integration tests for the compile errors stores bring: a project whose store
 * files live in a served dir (inside an asset dir) and an unserved one.
 */

import { assertEquals } from "jsr:@std/assert";
import * as path from "node:path";
import { compileDirectory } from "../compiler/partials.ts";
import { BackflipError } from "../compiler/errors.ts";

const PROJECT = new URL("./stores-project", import.meta.url).pathname;
const STORE_DIRS = [path.join(PROJECT, "static/stores"), path.join(PROJECT, "server/stores")];
const ASSET_DIRS = new Map([["static", path.join(PROJECT, "static")]]);

const { directory, errors } = await compileDirectory(path.join(PROJECT, "templates-error"), { storeDirs: STORE_DIRS, assetDirs: ASSET_DIRS });

function findError(messagePart: string): BackflipError {
    const match = errors.find(e => e.message.includes(messagePart));
    if (!match) throw new Error(`No error matching "${messagePart}".\nAvailable:\n  ${errors.map(e => e.message).join("\n  ")}`);
    return match;
}

Deno.test("stores project: store files are read into the store table, served or not", () => {
    assertEquals(directory.stores.get("widgets")!.src, "@static/stores/widgets.js");
    assertEquals(directory.stores.get("users")!.src, undefined);
});

Deno.test("stores project: reports exactly the store errors", () => {
    assertEquals(errors.filter(e => e.severity !== "warning").length, 7, errors.map(e => e.message).join("\n"));
});

Deno.test("stores project: an undeclared store", () => {
    const e = findError("b-store:gadgets names no declared store");
    assertEquals([e.filename, e.line, e.col], ["store-errors.html", 1, 28]);
});

Deno.test("stores project: b-store on a nested element", () => {
    assertEquals(findError("b-store is only allowed on partial definitions").line, 2);
});

Deno.test("stores project: an unserved store on a generating partial", () => {
    const e = findError("<my-unserved> generates client JS, so it may only declare stores the browser can load");
    assertEquals([e.line, e.col], [3, 14]);
});

Deno.test("stores project: b-store and b-attr with the same name", () => {
    assertEquals(findError("b-store:widgets conflicts with b-attr:widgets").line, 4);
});

Deno.test("stores project: b-data naming a store the target declares", () => {
    assertEquals(findError("b-data:widgets is not allowed: <card> declares b-store:widgets").line, 6);
});

Deno.test("stores project: a called partial using a store it does not declare", () => {
    assertEquals(findError("variable users used in partial <reader> but not passed at this call site").line, 8);
});

Deno.test("stores project: a generating partial using a store it does not declare", () => {
    assertEquals(findError("variable widgets cannot be supplied to <my-undeclared>").line, 9);
});
