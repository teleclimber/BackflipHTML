# DOM-patch generator

Produces a JavaScript file with one class per custom-element partial that has at least one reactive attribute. The class lets browser-side code update specific attributes of specific rendered elements when one of the custom element's own attributes changes — without re-rendering the whole subtree.

## How it fits

Unlike the [`js/`](../js/README.md) and [`php/`](../php/README.md) generators (which only read the AST), dom-patch **mutates** the un-flattened AST on its way through. For every qualifying attribute site it appends a `data-bfid="..."` static attribute to the owning element so the runtime class can find it via `querySelector`. For a qualifying `{{ print }}` it inserts a pair of marker **comment** nodes around the print (and a `data-bfid` on the parent element). The mutated AST then flows to the other generators, so the server-rendered HTML carries the same markers.

Because of this, the CLI calls `applyDomPatch()` on each `CompiledFile` **before** running flatten + js/php codegen. The preview server does the same before rendering (see `preview/preview.ts`), so previewed HTML carries the same `data-bfid` markers as a real build.

## What qualifies

Four site flavors are emitted:

- **`attr`** — a `b-bind:`/`:` dynamic attribute on an element inside the partial body. The owning element gets a `data-bfid` so the runtime can find it via `querySelector`.
- **`definition-root-attr`** — a `b-bind:`/`:` dynamic attribute on the partial's own wrapping tag (i.e. the custom element itself). No `data-bfid` is added — the runtime already holds a direct reference to the custom element (`this.ce`).
- **`print`** — a `{{ expr }}` interpolation. The print is bracketed by two marker comment nodes (`<!--bfid:<id>-->`), and its parent element gets a `data-bfid`. When the print sits directly inside the custom element (no wrapping element), the parent is `this.ce` and no `data-bfid` is added. `b-if` / `b-for` wrappers are DOM-transparent, so the "parent element" is the nearest enclosing real element and the markers are inserted as immediate siblings of the print (inside the branch).
- **`if-set`** — a whole `b-if` / `b-else-if` / `b-else` set, tracked as **one** site (not one per branch). Anchored exactly like a print: a marker pair brackets the `IfTNode` in its container array, and the nearest enclosing element gets a `data-bfid` (or the target is `this.ce`). Unlike the other flavors this one generates *new DOM* in the browser — see [b-if sets](#b-if-sets) below.

A site qualifies when **all** of these hold:

- The owning partial is a **custom-element partial** (`b-attr:` declarations are the source of "live" variables).
- For attrs: the attribute is a `b-bind:`/`:` dynamic attribute (a `Parsed` expression in `AttrPart.dynamic.expr`). For prints: the `{{ expr }}`'s `Parsed`. For if-sets: every branch condition.
- Every variable in `parsed.vars` is one of the partial's live vars. Mixed live + non-live expressions are skipped entirely.
- The site is **not** inside a `b-for` loop. (v1 limitation — see below.)

Sites that don't qualify are silently ignored: `b-for` iterables, `b-data:` bindings, caller-side attr expressions on nested custom-element calls. Slot contents are not entered (they live in the caller's scope).

If a partial produces zero classes, it contributes nothing to the file. If a file produces zero classes, no file is emitted.

## v1 limitation: no for-loop sites

Sites whose ancestor chain contains a `ForTNode` are skipped (attrs, prints and if-sets alike). The bfid mechanism relies on `querySelector`, which returns only the first match — so a site on a `b-for`'d element would only update one of N rendered copies. This is documented rather than worked around; an explicit error is not raised (it's a silent skip, as for any non-qualifying site).

Other deliberate v1 limitations, all covered above: a set nested inside another set is skipped; patch sites inside an inactive branch log `console.error` on every mutate; `<script>` tags inside a branch do not execute when inserted via a fragment; and the initial active index is recomputed and trusted to match the server render.

## b-if sets

Attr and print patching edits DOM that is already there. An if-set instead **renders new DOM** when a different branch wins: the generated module ships a snapshot of the whole set as an RNode literal (the same data shape `generate/js` emits, produced by `nodeToJS`), calls the JS runtime's `render()` on it, and swaps the result into the marker range.

Three consequences shape the design:

- **`render.js` is a build input.** The generated module does `import { render } from './render.js'`, and the CLI copies `dist/runtime/js/render.js` into the root of the dom-patch output dir. The specifier is depth-relative (`foo/bar.js` → `../render.js`), computed by `renderImportPathFor()`. If the `dist` file is missing the build **errors and stops** — a silent skip would ship a page that 404s on import. `applyDomPatch` reports `needsRender` so the CLI knows whether the copy is required, and the preview server maps `<domPatchOutputDir>/render.js` to the same `dist` file.
- **The snapshot must be taken last.** `applyDomPatch` runs two passes per partial: pass 1 collects attr/print sites and mutates the AST (`data-bfid`s, print markers), pass 2 inserts each if-set's marker pair and snapshots its `IfTNode`. Taking the snapshot earlier would produce client-rendered branches missing the markers the server-rendered HTML has, and every patch site inside a re-rendered branch would stop working.
- **The HTML becomes DOM via `range.createContextualFragment()`**, with the range's contents set to the target element, so a branch is parsed in its real parent context (a `<tr>` under a `<tbody>` survives).

### Trigger variables

An if-set is driven **only by the live vars in its own branch conditions**. Vars in nested if-sets or `b-for` iterables inside the branches do not trigger it, and nothing is unioned across sets. So a nested `b-if` whose condition changes while the outer condition is unchanged will not re-render (accepted v1 limitation):

```html
<div b-if="a">
  <p b-if="b">…</p>   <!-- changing `b` alone does not update this -->
</div>
```

### Active-branch tracking

The constructor computes the active branch index from `collectData()` and stores it in `this.if_<setId>` — it **does not render**, since the server already emitted the right branch. The index is only used to decide whether a later data change actually changed branches. It is `0…n-1` for the winning branch, `-1` when nothing matches (a set with no `b-else` whose conditions are all falsy). The recomputed index is trusted to match the server render; if it doesn't, the DOM stays stale until the index changes.

### Additional qualification rules

Beyond the cross-kind rules, an if-set qualifies only when all of these hold. Any failure disqualifies the **entire set** (all branches), silently:

1. It is **not inside another if-set** — qualifying or not. Once a set is disqualified everything within it is too; only a top-level set can be a patch site.
2. Every branch condition parses and names **at least one** variable.
3. Every expression **anywhere in the subtree** references only live vars — prints, dynamic attrs, nested `b-if` conditions, nested `b-for` iterables. A `b-for`'s value name is locally bound inside its own body, so `valName` and `valName.x` are exempt within that scope (scope tracking is required, since nested `b-for` is allowed).
4. No **partial references** of any kind in the subtree — no `b-part` calls, no custom-element calls.
5. No **slot** nodes in the subtree.
6. No **asset references** in the subtree: no unresolved `asset` AttrPart, no dynamic attr with `isAsset`, no static attr whose raw text contains an `@name/` reference. (The browser has no asset map.)

Nested `b-for` and nested `b-if`/`b-else` are otherwise **allowed** inside a qualifying set — they are rendered statically by `render.js` as part of the set's output, and are not patch sites themselves.

### Ordering within `mutate_<var>`

If-set re-rendering happens **first**, before any attribute/print mutations in the same `mutate_<var>` body, since those sites may live in the branch about to be replaced. Patch sites inside a currently-inactive branch are not found and `console.error` through the existing null guard — that is the status quo, and this feature does not change the patching logic to accommodate missing elements.

## Generated class shape

For a partial `my-element` with live vars `title` and `flag`:

```js
import { render } from './render.js';   // only when the file has at least one if-set

const bfif_<setId> = { type:'if', branches: [ ... ] };   // one per if-set, module level

class BackflipMyElement {
    constructor(ce) { this.ce = ce; /* + this.if_<setId> = this.branch_<setId>(this.collectData()); */ }
    sel_<bfid>() { return this.ce.querySelector('[data-bfid="<bfid>"]'); }
    bc_<bfid>_<attr>(data) { ... }       // attr expression body, destructured from data
    bc_ce_<attr>(data) { ... }           // for definition-root attrs (no bfid; target is this.ce)
    bc_print_<startId>(data) { ... }     // print expression body (keyed off the leading marker id)
    branch_<setId>(data) { ... }         // → active branch index, or -1 when none matches
    renderIf_<setId>(data) { ... }       // re-render + swap, but only if the index changed
    replaceBetween(parent, startMarker, endMarker, node) { ... }   // emitted for print sites and if-sets
    mutate_<varName>(data) { ... }       // renderIf_ calls first, then sel + bc + setAttribute / replaceBetween
    collectData() { return { title: ..., flag: ... }; }
    update(varName) { switch(varName) { case '<v>': this.mutate_<v>(this.collectData()); ... } }
}
```

Inside a `mutate_<varName>` body, sites are grouped by element. bfid-element sites use `elem = this.sel_<bfid>();`; definition-root and root-level-print sites use `elem = this.ce;`. Each group is guarded once: when `elem` is found the group's updates run; when it is null the guard's `else` branch logs `console.error(...)` and skips the update. A null lookup means the rendered DOM has diverged from the compiled template (something went wrong upstream), so it is reported rather than silently ignored.

Per-site updates within a found group:

- **attr** → `elem.setAttribute(name, String(...))`, or `setAttribute(name, '')`+`removeAttribute(name)` for booleans.
- **print** → `this.replaceBetween(elem, '<startMarker>', '<endMarker>', document.createTextNode(String(...)))`.
- **if-set** → `this.renderIf_<setId>(data)`, emitted before the element groups. It resolves the target itself (with the same null-guard `console.error`) and calls `replaceBetween` with the rendered fragment.

`replaceBetween(parent, startMarker, endMarker, node)` is the shared marker-range replace: it finds the two marker comments among `parent`'s direct children, removes every node strictly between them, and inserts `node` before the closing marker. Prints pass a text node (never `innerText`/`innerHTML`) so the parent's other children are preserved and the value is never interpreted as markup; if-sets pass the `DocumentFragment` of the freshly rendered branch. Either way the markers survive, so the range stays patchable. If a marker is missing it logs and skips, like the null-element guard.

Other notes:

- `collectData()` returns every declared `b-attr` (string → `getAttribute(name) ?? ''`; bool → `hasAttribute(name)`).
- `update(varName)` only switches over live vars **that have at least one mutate-able site** — including vars that appear *only* in an if-set's branch conditions. Unused live vars still appear in `collectData`, just not in `update`.
- Boolean dynamic attributes use `setAttribute(name, '')` / `removeAttribute(name)` to match the server-rendered HTML.

## Identifier sanitization

The bfid and attribute function name must be valid JS identifiers, but the runtime DOM call must use the original (stripped) attribute name. So `data-foo` becomes `bc_<bfid>_data_foo` in the function name but stays `'data-foo'` in `setAttribute`.

## Entry point

`applyDomPatch(file, opts?)` mutates the CompiledFile in place and returns `{ js: string | null, needsRender: boolean }` — `needsRender` is true when the generated module imports `render.js`, i.e. it contains at least one if-set. `opts` is `{ bfidGen?, scriptUrl?, renderImportPath? }`:

- `bfidGen` — deterministic id generator (`makeSequentialBfidGen()`) in tests; production uses the default crypto-random generator.
- `renderImportPath` — specifier for the JS runtime's `render.js`, used only when the file has an if-set. Defaults to `'./render.js'`; the CLI and preview pass a depth-relative path via `renderImportPathFor(outRelPath)`.
- `scriptUrl` — public URL of the JS file this run produces. When set, every partial that produces a patch class is stamped with `root.scriptUrl = scriptUrl` (on the `CustomElementPartialRoot`). Partials that produce **no** class are left unstamped, even when they share a file with one that does — a partial with no reactive sites needs no script. When `scriptUrl` is absent, generation is unchanged and nothing is stamped.

## Script auto-include

The stamped `scriptUrl` flows through the JS and PHP generators into the emitted root node, and the **renderer** auto-includes the scripts of the reactive custom-element partials it actually renders — there is no manual `<script>` step. The CLI derives each file's URL from the asset prefix that covers the dom-patch output dir (see [Assets](../../../docs/assets.md) and [Configuration](../../../docs/configuration.md)); if no asset prefix covers the output dir it warns and the scripts are not auto-included.

Inclusion follows what actually rendered server-side: a custom element in an untaken `b-if`/`b-else` branch, or a `b-for` over an empty iterable, contributes no script. Reactive `b-if` sets do toggle branches client-side, but this stays correct because **a branch containing a partial reference of any kind disqualifies its whole set** (see [b-if sets](#b-if-sets)). So a branch that is untaken server-side can never later introduce a custom element whose script was not included — any set that could do that is not reactive in the first place.
