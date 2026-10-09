/**
 * Integration tests for stores at render time: the same templates rendered by the
 * JS and PHP runtimes, with the stores the author's server code passes.
 *
 * The HTML outside the store tags must match byte for byte; the store payloads are
 * compared as decoded values, since the JSON encoders differ in key order and
 * number formatting.
 */

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { compileDirectory } from "../compiler/partials.ts";
import { applyDomPatch } from "../compiler/generate/dom-patch/nodes2patch.ts";
import { fileToJsModule } from "../compiler/generate/js/nodes2js.ts";
import { fileToPhpFile } from "../compiler/generate/php/nodes2php.ts";
import { resolveAssetRefs } from "../compiler/helpers.ts";
import { renderRoot, streamRenderRoot, type RootRNode } from "../runtime/js/render.ts";

const PROJECT = new URL("./stores-project", import.meta.url).pathname;
const RENDER_PHP = new URL("../runtime/php/render.php", import.meta.url).pathname;
const TMPDIR = "/tmp/claude-1000/stores-render";

const STORES = {
    widgets: { "42": { name: "Gizmo <b>", owner: "ann" }, "7": { name: "Widget & co", owner: "bob" } },
    tags: { list: ["a", "b"] },
    users: { ann: { full_name: "Ann \u2028Lee" }, bob: { full_name: "Bob </script>" } },
};

// One build for both runtimes: dom-patch bakes random bfids into the templates.
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

// `storesPhp` is a PHP expression for the stores, for values JSON cannot carry.
async function renderPhp(partial: string, ctx: object, stores: Record<string, unknown>, storesPhp?: string): Promise<string> {
    const dir = path.join(TMPDIR, `p_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(dir, { recursive: true });
    try {
        const phpPath = path.join(dir, "stores.php");
        await fs.writeFile(phpPath, fileToPhpFile(file, "stores.html"));
        const harness = `<?php
require '${RENDER_PHP}';
$partials = require '${phpPath}';
$ctx = json_decode(${JSON.stringify(JSON.stringify(ctx))}, true);
$stores = ${storesPhp ?? `json_decode(${JSON.stringify(JSON.stringify(stores))}, true)`};
$batch = backflip_renderRoot($partials['${partial}'], $ctx, [], $stores);
$streamed = implode('', iterator_to_array(backflip_streamRenderRoot($partials['${partial}'], $ctx, [], $stores), false));
if ($batch !== $streamed) { fwrite(STDERR, "streaming differs from batch"); exit(2); }
echo $batch;
`;
        const harnessPath = path.join(dir, "harness.php");
        await fs.writeFile(harnessPath, harness);
        const out = await new Deno.Command("php", { args: [harnessPath], stdout: "piped", stderr: "piped" }).output();
        const stderr = new TextDecoder().decode(out.stderr);
        if (out.code !== 0) throw new Error(`php failed (${out.code}): ${stderr}`);
        return new TextDecoder().decode(out.stdout);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

const TAG_RE = /<script type="application\/json" data-bf-store="(\w+)">(.*?)<\/script>/g;

// The HTML with each store tag's payload blanked, and the decoded payloads by name.
function split(html: string): { shell: string; payloads: Record<string, unknown> } {
    const payloads: Record<string, unknown> = {};
    const shell = html.replace(TAG_RE, (_m, name: string, json: string) => {
        payloads[name] = JSON.parse(json);
        return `<script type="application/json" data-bf-store="${name}"></script>`;
    });
    return { shell, payloads };
}

Deno.test("stores render: JS and PHP agree, shipping only stores read by rendered generated code", async () => {
    const js = renderJs("page", { title: "Hi" }, STORES);
    const php = await renderPhp("page", { title: "Hi" }, STORES);
    const a = split(js), b = split(php);
    assertEquals(a.shell, b.shell);
    assertEquals(a.payloads, b.payloads);

    // Read on the server through each declaring partial's own binding.
    assertStringIncludes(js, "Hi: Ann \u2028Lee</p>");
    assertStringIncludes(js, "-->Gizmo &lt;b&gt;<!--");
    assertStringIncludes(js, "-->Widget &amp; co<!--");
    assertStringIncludes(js, '<p class="owner">Bob &lt;/script&gt;</p>');
    // widgets: read by my-widget's patch sites → shipped once, with its file.
    // tags: read only inside a b-for → not shipped. users: server-only partials → not shipped.
    assertEquals(Object.keys(a.payloads), ["widgets"]);
    assertEquals(a.payloads.widgets, STORES.widgets);
    assertEquals(js.match(/modulepreload" href="\/static\/stores\/widgets.js"/g)?.length, 1);
    assertEquals(js.includes("stores/tags.js") || js.includes("users"), false);
    // The tags precede every script in the block.
    assertEquals(js.indexOf("data-bf-store") < js.indexOf("<link rel=\"modulepreload\""), true);
});

Deno.test("stores render: the JSON is escaped so it cannot end the tag, in both runtimes", async () => {
    const stores = { ...STORES, widgets: { "42": { name: "</script><!--&\u2028\u2029é/", owner: "x" } } };
    for (const html of [renderJs("page", { title: "" }, stores), await renderPhp("page", { title: "" }, stores)]) {
        assertStringIncludes(html, '{"42":{"name":"\\u003C/script\\u003E\\u003C!--\\u0026\\u2028\\u2029é/","owner":"x"}}');
    }
});

Deno.test("stores render: an untaken b-if and an empty b-for ship nothing", async () => {
    const ctx = { show: false, items: [] };
    for (const html of [renderJs("untaken", ctx, STORES), await renderPhp("untaken", ctx, STORES)]) {
        assertEquals(html.includes("data-bf-store"), false, html);
        assertEquals(html.includes("<script") || html.includes("<link"), false, html);
    }
    const shown = { show: true, items: ["7"] };
    const a = split(renderJs("untaken", shown, STORES)), b = split(await renderPhp("untaken", shown, STORES));
    assertEquals(a.shell, b.shell);
    assertEquals(Object.keys(a.payloads), ["widgets"]);
    assertEquals(a.payloads, b.payloads);
});

Deno.test("stores render: an empty store map and a list-shaped one decode the same in both runtimes", async () => {
    const stores = { ...STORES, widgets: ["zero", "one"] };
    const a = split(renderJs("page", { title: "" }, stores)), b = split(await renderPhp("page", { title: "" }, stores));
    assertEquals(a.payloads, b.payloads);
    assertEquals(a.payloads.widgets, ["zero", "one"]);
});

Deno.test("stores render: a missing store is a render error in both runtimes", async () => {
    const { widgets: _, ...noWidgets } = STORES;
    let jsError = "";
    try { renderJs("page", { title: "" }, noWidgets); } catch (e) { jsError = (e as Error).message; }
    assertStringIncludes(jsError, 'partial "my-widget" declares b-store:widgets, but no store "widgets" was passed to the renderer');
    let phpError = "";
    try { await renderPhp("page", { title: "" }, noWidgets); } catch (e) { phpError = (e as Error).message; }
    assertStringIncludes(phpError, 'partial \\"my-widget\\" declares b-store:widgets, but no store \\"widgets\\" was passed to the renderer'.replaceAll('\\"', '"'));
});

Deno.test("stores render: a root ctx key naming a store the root declares is a render error in both runtimes", async () => {
    let jsError = "";
    try { renderJs("page", { title: "", users: 1 }, STORES); } catch (e) { jsError = (e as Error).message; }
    assertStringIncludes(jsError, 'ctx key "users" is also a store the root partial "page" declares');
    let phpError = "";
    try { await renderPhp("page", { title: "", users: 1 }, STORES); } catch (e) { phpError = (e as Error).message; }
    assertStringIncludes(phpError, 'ctx key "users" is also a store the root partial "page" declares');
});

Deno.test("stores render: a shipped store that cannot be serialized is a render error in both runtimes", async () => {
    const cyclic: Record<string, unknown> = { "42": { name: "x", owner: "y" } };
    cyclic.self = cyclic;
    let jsError = "";
    try { renderJs("page", { title: "" }, { ...STORES, widgets: cyclic }); } catch (e) { jsError = (e as Error).message; }
    assertStringIncludes(jsError, 'store "widgets" cannot be serialized to JSON');
    let phpError = "";
    const storesPhp = `array_merge(json_decode(${JSON.stringify(JSON.stringify(STORES))}, true), ['widgets' => ['42' => ['name' => 'x', 'owner' => 'y'], 'bad' => NAN]])`;
    try { await renderPhp("page", { title: "" }, {}, storesPhp); } catch (e) { phpError = (e as Error).message; }
    assertStringIncludes(phpError, 'store "widgets" cannot be serialized to JSON');
});
