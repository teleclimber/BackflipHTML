/**
 * Integration tests for stores at render time: templates rendered by the JS runtime
 * with the stores the author's server code passes. Every render is checked batch
 * against streaming.
 */

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import * as path from "node:path";
import { compileDirectory } from "../compiler/partials.ts";
import { applyDomPatch } from "../compiler/generate/dom-patch/nodes2patch.ts";
import { fileToJsModule } from "../compiler/generate/js/nodes2js.ts";
import { resolveAssetRefs } from "../compiler/helpers.ts";
import { renderRoot, streamRenderRoot, type RootRNode } from "../runtime/js/render.ts";

const PROJECT = new URL("./stores-project", import.meta.url).pathname;

const STORES = {
    widgets: { "42": { name: "Gizmo <b>", owner: "ann" }, "7": { name: "Widget & co", owner: "bob" } },
    tags: { list: ["a", "b"] },
    users: { ann: { full_name: "Ann \u2028Lee" }, bob: { full_name: "Bob </script>" } },
};

const { directory, errors } = await compileDirectory(path.join(PROJECT, "templates"), {
    storeDirs: [path.join(PROJECT, "static/stores"), path.join(PROJECT, "server/stores")],
    assetDirs: new Map([["static", path.join(PROJECT, "static")]]),
});
if (errors.length > 0) throw new Error(errors.map(e => e.message).join("\n"));
const compiled = directory.files.get("stores.html")!;
applyDomPatch(compiled, { scriptUrlFor: tag => `/static/bfdom/${tag}.js` });
const file = resolveAssetRefs(compiled, new Map([["static", "/static/"]]));

function jsPartials(): Record<string, RootRNode> {
    const js = fileToJsModule(file, "stores.html");
    const names = [...js.matchAll(/^export const (\w+)/gm)].map(m => m[1]);
    return new Function(js.replace(/^export const /gm, "const ") + `\nreturn { ${names.join(", ")} };`)();
}

function renderJs(partial: string, ctx: object, stores: Record<string, unknown>): string {
    const root = jsPartials()[partial];
    const batch = renderRoot(root, ctx, undefined, stores);
    assertEquals(Array.from(streamRenderRoot(root, ctx, undefined, stores)).join(""), batch);
    return batch;
}

const TAG_RE = /<script type="application\/json" data-bf-store="(\w+)">(.*?)<\/script>/g;

// The decoded store payloads in the HTML, by name, in order.
function payloadsOf(html: string): Record<string, unknown> {
    const payloads: Record<string, unknown> = {};
    for (const [, name, json] of html.matchAll(TAG_RE)) payloads[name] = JSON.parse(json);
    return payloads;
}

Deno.test("stores render: ships only stores read by rendered generated code", () => {
    const js = renderJs("page", { title: "Hi" }, STORES);
    const payloads = payloadsOf(js);

    // Read on the server through each declaring partial's own binding.
    assertStringIncludes(js, "Hi: Ann \u2028Lee</p>");
    assertStringIncludes(js, "-->Gizmo &lt;b&gt;<!--");
    assertStringIncludes(js, "-->Widget &amp; co<!--");
    assertStringIncludes(js, '<p class="owner">Bob &lt;/script&gt;</p>');
    // widgets: read by my-widget's patch sites → shipped once, with its file.
    // tags: read by my-tagger's reactive b-for → shipped. users: server-only partials → not shipped.
    assertEquals(Object.keys(payloads), ["widgets", "tags"]);
    assertEquals(payloads.widgets, STORES.widgets);
    assertEquals(payloads.tags, STORES.tags);
    assertEquals(js.match(/modulepreload" href="\/static\/stores\/widgets.js"/g)?.length, 1);
    assertEquals(js.match(/modulepreload" href="\/static\/stores\/tags.js"/g)?.length, 1);
    assertEquals(js.includes("users"), false);
    // The tags precede every script in the block.
    assertEquals(js.indexOf("data-bf-store") < js.indexOf("<link rel=\"modulepreload\""), true);
});

Deno.test("stores render: the JSON is escaped so it cannot end the tag", () => {
    const stores = { ...STORES, widgets: { "42": { name: "</script><!--&\u2028\u2029é/", owner: "x" } } };
    const html = renderJs("page", { title: "" }, stores);
    assertStringIncludes(html, '{"42":{"name":"\\u003C/script\\u003E\\u003C!--\\u0026\\u2028\\u2029é/","owner":"x"}}');
});

Deno.test("stores render: an untaken b-if and an empty b-for ship nothing", () => {
    const html = renderJs("untaken", { show: false, items: [] }, STORES);
    assertEquals(html.includes("data-bf-store"), false, html);
    assertEquals(html.includes("<script") || html.includes("<link"), false, html);
    assertEquals(payloadsOf(renderJs("untaken", { show: true, items: ["7"] }, STORES)), { widgets: STORES.widgets });
});

Deno.test("stores render: a list-shaped store ships as a list", () => {
    const stores = { ...STORES, widgets: ["zero", "one"] };
    assertEquals(payloadsOf(renderJs("page", { title: "" }, stores)).widgets, ["zero", "one"]);
});

Deno.test("stores render: a missing store is a render error", () => {
    const { widgets: _, ...noWidgets } = STORES;
    let jsError = "";
    try { renderJs("page", { title: "" }, noWidgets); } catch (e) { jsError = (e as Error).message; }
    assertStringIncludes(jsError, 'partial "my-widget" declares b-store:widgets, but no store "widgets" was passed to the renderer');
});

Deno.test("stores render: a root ctx key naming a store the root declares is a render error", () => {
    let jsError = "";
    try { renderJs("page", { title: "", users: 1 }, STORES); } catch (e) { jsError = (e as Error).message; }
    assertStringIncludes(jsError, 'ctx key "users" is also a store the root partial "page" declares');
});

Deno.test("stores render: a shipped store that cannot be serialized is a render error", () => {
    const cyclic: Record<string, unknown> = { "42": { name: "x", owner: "y" } };
    cyclic.self = cyclic;
    let jsError = "";
    try { renderJs("page", { title: "" }, { ...STORES, widgets: cyclic }); } catch (e) { jsError = (e as Error).message; }
    assertStringIncludes(jsError, 'store "widgets" cannot be serialized to JSON');
});
