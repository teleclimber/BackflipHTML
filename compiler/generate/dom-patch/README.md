# DOM-patch generator

Produces a JavaScript file with one class per custom-element partial that has at least one reactive attribute. The class lets browser-side code update specific attributes of specific rendered elements when one of the custom element's own attributes changes — without re-rendering the whole subtree.

## How it fits

Unlike the [`js/`](../js/README.md) and [`php/`](../php/README.md) generators (which only read the AST), dom-patch **mutates** the un-flattened AST on its way through. For every qualifying attribute site it appends a `data-bfid="..."` static attribute to the owning element so the runtime class can find it via `querySelector`. For a qualifying `{{ print }}` it inserts a pair of marker **comment** nodes around the print (and a `data-bfid` on the parent element). The mutated AST then flows to the other generators, so the server-rendered HTML carries the same markers.

Because of this, the CLI calls `applyDomPatch()` on each `CompiledFile` **before** running flatten + js/php codegen. The preview server does the same before rendering (see `preview/preview.ts`), so previewed HTML carries the same `data-bfid` markers as a real build.

## What qualifies

Three site flavors are emitted:

- **`attr`** — a `b-bind:`/`:` dynamic attribute on an element inside the partial body. The owning element gets a `data-bfid` so the runtime can find it via `querySelector`.
- **`definition-root-attr`** — a `b-bind:`/`:` dynamic attribute on the partial's own wrapping tag (i.e. the custom element itself). No `data-bfid` is added — the runtime already holds a direct reference to the custom element (`this.ce`).
- **`print`** — a `{{ expr }}` interpolation. The print is bracketed by two marker comment nodes (`<!--bfid:<id>-->`), and its parent element gets a `data-bfid`. When the print sits directly inside the custom element (no wrapping element), the parent is `this.ce` and no `data-bfid` is added. `b-if` / `b-for` wrappers are DOM-transparent, so the "parent element" is the nearest enclosing real element and the markers are inserted as immediate siblings of the print (inside the branch).

A site qualifies when **all** of these hold:

- The owning partial is a **custom-element partial** (`b-attr:` declarations are the source of "live" variables).
- For attrs: the attribute is a `b-bind:`/`:` dynamic attribute (a `Parsed` expression in `AttrPart.dynamic.expr`). For prints: the `{{ expr }}`'s `Parsed`.
- Every variable in `parsed.vars` is one of the partial's live vars. Mixed live + non-live expressions are skipped entirely.
- The site is **not** inside a `b-for` loop. (v1 limitation — see below.)

Sites that don't qualify are silently ignored: `b-if` conditions, `b-for` iterables, `b-data:` bindings, caller-side attr expressions on nested custom-element calls. Slot contents are not entered (they live in the caller's scope).

If a partial produces zero classes, it contributes nothing to the file. If a file produces zero classes, no file is emitted.

## v1 limitation: no for-loop sites

Sites whose ancestor chain contains a `ForTNode` are skipped (attrs and prints alike). The bfid mechanism relies on `querySelector`, which returns only the first match — so a site on a `b-for`'d element would only update one of N rendered copies. This is documented rather than worked around; an explicit error is not raised (it's a silent skip, as for any non-qualifying site).

## Generated class shape

For a partial `my-element` with live vars `title` and `flag`:

```js
class BackflipMyElement {
    constructor(ce) { this.ce = ce; }
    sel_<bfid>() { return this.ce.querySelector('[data-bfid="<bfid>"]'); }
    bc_<bfid>_<attr>(data) { ... }       // attr expression body, destructured from data
    bc_ce_<attr>(data) { ... }           // for definition-root attrs (no bfid; target is this.ce)
    bc_print_<startId>(data) { ... }     // print expression body (keyed off the leading marker id)
    patchTextBetween(parent, startMarker, endMarker, text) { ... }   // emitted only when a print site exists
    mutate_<varName>(data) { ... }       // calls sel + bc + setAttribute / removeAttribute / patchTextBetween
    collectData() { return { title: ..., flag: ... }; }
    update(varName) { switch(varName) { case '<v>': this.mutate_<v>(this.collectData()); ... } }
}
```

Inside a `mutate_<varName>` body, sites are grouped by element. bfid-element sites use `elem = this.sel_<bfid>();`; definition-root and root-level-print sites use `elem = this.ce;`. Each group is guarded once: when `elem` is found the group's updates run; when it is null the guard's `else` branch logs `console.error(...)` and skips the update. A null lookup means the rendered DOM has diverged from the compiled template (something went wrong upstream), so it is reported rather than silently ignored.

Per-site updates within a found group:

- **attr** → `elem.setAttribute(name, String(...))`, or `setAttribute(name, '')`+`removeAttribute(name)` for booleans.
- **print** → `this.patchTextBetween(elem, '<startMarker>', '<endMarker>', String(...))`. The helper finds the two marker comments among `elem`'s direct children, removes the nodes strictly between them, and inserts a single `document.createTextNode(...)` before the closing marker. A text node (never `innerText`/`innerHTML`) is used so the parent's other children are preserved and the value is never interpreted as markup. If a marker is missing it logs and skips, like the null-element guard.

Other notes:

- `collectData()` returns every declared `b-attr` (string → `getAttribute(name) ?? ''`; bool → `hasAttribute(name)`).
- `update(varName)` only switches over live vars **that have at least one mutate-able site**. Unused live vars still appear in `collectData`, just not in `update`.
- Boolean dynamic attributes use `setAttribute(name, '')` / `removeAttribute(name)` to match the server-rendered HTML.

## Identifier sanitization

The bfid and attribute function name must be valid JS identifiers, but the runtime DOM call must use the original (stripped) attribute name. So `data-foo` becomes `bc_<bfid>_data_foo` in the function name but stays `'data-foo'` in `setAttribute`.

## Entry point

`applyDomPatch(file, opts?)` mutates the CompiledFile in place and returns `{ js: string | null }`. `opts` is `{ bfidGen?, scriptUrl? }`:

- `bfidGen` — deterministic id generator (`makeSequentialBfidGen()`) in tests; production uses the default crypto-random generator.
- `scriptUrl` — public URL of the JS file this run produces. When set, every partial that produces a patch class is stamped with `root.scriptUrl = scriptUrl` (on the `CustomElementPartialRoot`). Partials that produce **no** class are left unstamped, even when they share a file with one that does — a partial with no reactive sites needs no script. When `scriptUrl` is absent, generation is unchanged and nothing is stamped.

## Script auto-include

The stamped `scriptUrl` flows through the JS and PHP generators into the emitted root node, and the **renderer** auto-includes the scripts of the reactive custom-element partials it actually renders — there is no manual `<script>` step. The CLI derives each file's URL from the asset prefix that covers the dom-patch output dir (see [Assets](../../../docs/assets.md) and [Configuration](../../../docs/configuration.md)); if no asset prefix covers the output dir it warns and the scripts are not auto-included.

Inclusion follows what actually rendered server-side: a custom element in an untaken `b-if`/`b-else` branch, or a `b-for` over an empty iterable, contributes no script. This is correct today because dom-patch does not toggle `b-if`/`b-else` branches client-side, so whatever rendered on the server is frozen. Making branches reactive in the browser is future work that will need separate handling for script inclusion.
