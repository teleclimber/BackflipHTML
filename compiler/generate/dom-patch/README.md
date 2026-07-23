# DOM-patch generator

Produces a JavaScript file with, per custom-element partial that has at least one reactive attribute, an exported `BackflipMyElement` shell plus a tree of module-private **patch-branch** classes. Together they let browser-side code update specific attributes, prints, and `b-if` branches of the rendered subtree when one of the custom element's own attributes changes — without re-rendering the whole thing. See [patch-branches](#patch-branches).

## How it fits

Unlike the [`js/`](../js/README.md) and [`php/`](../php/README.md) generators (which only read the AST), dom-patch **mutates** the un-flattened AST on its way through. For every qualifying attribute site it appends a `data-bfid="..."` static attribute to the owning element so the runtime class can find it via `querySelector`. For a qualifying `{{ print }}` it inserts a pair of marker **comment** nodes around the print (and a `data-bfid` on the parent element). The mutated AST then flows to the other generators, so the server-rendered HTML carries the same markers.

Because of this, the CLI calls `applyDomPatch()` on each `CompiledFile` **before** running flatten + js/php codegen. The preview server does the same before rendering (see `preview/preview.ts`), so previewed HTML carries the same `data-bfid` markers as a real build.

## What qualifies

Four site flavors are emitted:

- **`attr`** — a `b-bind:`/`:` dynamic attribute on an element inside the partial body. The owning element gets a `data-bfid` so the runtime can find it via `querySelector`.
- **`definition-root-attr`** — a `b-bind:`/`:` dynamic attribute on the partial's own wrapping tag (i.e. the custom element itself). No `data-bfid` is added — it resolves to the owning patch-branch's `ref_elem`, which for the root is the custom element (`this.ce`).
- **`print`** — a `{{ expr }}` interpolation. The print is bracketed by two marker comment nodes (`<!--bfid:<id>-->`), and its parent element gets a `data-bfid`. When that parent *is* the owning patch-branch's ref element (a print directly inside the custom element, or in a `b-unwrap` branch), no `data-bfid` is added and it targets `ref_elem`. `b-if` / `b-for` wrappers are DOM-transparent, so the "parent element" is the nearest enclosing real element and the markers are inserted as immediate siblings of the print (inside the branch).
- **`if-set`** — a whole `b-if` / `b-else-if` / `b-else` set, tracked as **one** site (not one per branch). Anchored exactly like a print: a marker pair brackets the `IfTNode` in its container array, and the nearest enclosing element gets a `data-bfid` (or it targets the owning patch-branch's `ref_elem`). Unlike the other flavors this one generates *new DOM* in the browser — see [b-if sets](#b-if-sets) below.

A site qualifies when **all** of these hold:

- The owning partial is a **custom-element partial** (`b-attr:` declarations are the source of "live" variables).
- For attrs: the attribute is a `b-bind:`/`:` dynamic attribute (a `Parsed` expression in `AttrPart.dynamic.expr`). For prints: the `{{ expr }}`'s `Parsed`. For if-sets: every branch condition.
- Every variable in `parsed.vars` is one of the partial's live vars. Mixed live + non-live expressions are skipped entirely.
- The site is **not** inside a `b-for` loop. (v1 limitation — see below.)

Sites that don't qualify are silently ignored: `b-for` iterables, `b-data:` bindings, caller-side attr expressions on nested custom-element calls. Slot contents are not entered (they live in the caller's scope).

If a partial produces zero classes, it contributes nothing to the file. If a file produces zero classes, no file is emitted.

## v1 limitation: no for-loop sites

Sites whose ancestor chain contains a `ForTNode` are skipped (attrs, prints and if-sets alike). The bfid mechanism relies on `querySelector`, which returns only the first match — so a site on a `b-for`'d element would only update one of N rendered copies. This is documented rather than worked around; an explicit error is not raised (it's a silent skip, as for any non-qualifying site).

Other deliberate limitations, all covered above: patch sites inside an inactive branch of a **non-qualifying** nested set log `console.error` on every mutate (only qualifying sets get the patch-branch treatment that avoids this); `<script>` tags inside a branch do not execute when inserted via a fragment; and the initial active index is recomputed and trusted to match the server render. Nested `b-if` **is** supported — see [patch-branches](#patch-branches).

## b-if sets

Attr and print patching edits DOM that is already there. An if-set instead **renders new DOM** when a different branch wins: the generated module ships a snapshot of the whole set as an RNode literal (the same data shape `generate/js` emits, produced by `nodeToJS`), calls the JS runtime's `render()` on it, and swaps the result into the marker range.

Three consequences shape the design:

- **`render.js` is a build input.** The generated module does `import { render } from './render.js'`, and the CLI copies `dist/runtime/js/render.js` into the root of the dom-patch output dir. The specifier is depth-relative (`foo/bar.js` → `../render.js`), computed by `renderImportPathFor()`. If the `dist` file is missing the build **errors and stops** — a silent skip would ship a page that 404s on import. `applyDomPatch` reports `needsRender` so the CLI knows whether the copy is required, and the preview server maps `<domPatchOutputDir>/render.js` to the same `dist` file.
- **Snapshots are taken after all AST mutation, recursively.** `applyDomPatch` runs two passes per partial over the patch-branch tree (see [patch-branches](#patch-branches)): pass 1 mutates the AST at every depth (`data-bfid`s, print markers, and every set's marker pair), pass 2 snapshots each set's `IfTNode`. Taking a snapshot before every nested marker exists would produce a client-rendered branch missing markers the server-rendered HTML has, and every patch site inside it — including a nested set's anchors — would stop working.
- **The HTML becomes DOM via `range.createContextualFragment()`**, with the range's contents set to the target element, so a branch is parsed in its real parent context (a `<tr>` under a `<tbody>` survives).

### Trigger variables

An if-set is re-rendered (its branch swapped) **only by the live vars in its own branch conditions**. But a var referenced deeper — in a nested set's condition, or in branch content — still needs to reach that content. A patch-branch therefore also tracks the live vars anywhere in its subtree and **forwards** a change down to the active child patch-branch, which either re-renders its own nested set or patches its own sites. So a nested `b-if` whose condition changes while the outer condition is unchanged **does** re-render (via forwarding):

```html
<div b-if="a">
  <p b-if="b">…</p>   <!-- changing `b` re-renders just this inner branch -->
</div>
```

### Active-branch tracking

Each patch-branch's constructor computes every owned set's active branch index from the data it's handed and stores it in `this.if_<setId>` — it **does not render**, since the server already emitted the right branch. It also seeds `this.if_pb_<setId>` (a branch-index → child-patch-branch map) and eagerly constructs the child for the active branch. The index is `0…n-1` for the winning branch, `-1` when nothing matches (a set with no `b-else` whose conditions are all falsy). The recomputed index is trusted to match the server render; if it doesn't, the DOM stays stale until the index changes.

### Additional qualification rules

Beyond the cross-kind rules, an if-set qualifies only when all of these hold. Any failure disqualifies the **entire set** (all branches), silently:

1. Every branch condition parses and names **at least one** variable.
2. Every expression **anywhere in the subtree** references only live vars — prints, dynamic attrs, nested `b-if` conditions, nested `b-for` iterables. A `b-for`'s value name is locally bound inside its own body, so `valName` and `valName.x` are exempt within that scope (scope tracking is required, since nested `b-for` is allowed).
3. No **partial references** of any kind in the subtree — no `b-part` calls, no custom-element calls.
4. No **slot** nodes in the subtree.
5. No **asset references** in the subtree: no unresolved `asset` AttrPart, no dynamic attr with `isAsset`, no static attr whose raw text contains an `@name/` reference. (The browser has no asset map.)

Nesting is allowed: a qualifying set may sit inside another. Because rule 2 walks the **whole** subtree, a disqualifier inside a nested set (a non-live var, a partial ref) sinks the enclosing set too — so a qualifying parent only ever contains nested sets that themselves qualify or are var-free (`b-if="1 == 1"`, which can't be its own patch site but doesn't disqualify anyone). A nested `b-for` is rendered statically as part of the branch that owns it and is not a patch site.

### Ordering within `mutate_<var>`

Within a single patch-branch, if-set handling runs **first** in a `mutate_<var>` body, before that branch's own attr/print mutations. A re-render replaces a whole subtree, so any local site must be patched against the DOM that results. There is no longer a cross-boundary hazard: a patch-branch never owns a site that lives inside a branch it re-renders — those sites belong to the child patch-branch, which is (re)built by the swap. A non-qualifying nested set is the exception: its content stays parent-owned, so a site in its inactive branch is not found and `console.error`s through the null guard.

## Generated class shape

The mutation logic lives in **patch-branches** (see [patch-branches](#patch-branches)); `BackflipMyElement` is a thin shell that owns the host, `collectData()`, and the root patch-branch. For a partial `my-element` with live vars `title` and `flag`:

```js
import { render } from './render.js';   // only when the file has at least one if-set

const bfif_<setId> = { type:'if', branches: [ ... ] };   // one per if-set, module level

class BackflipPatch_MyElement {          // one patch-branch class per qualifying branch
    constructor(ref_elem, data) { this.ref_elem = ref_elem; /* + per-set seeding */ }
    sel_<bfid>() { return this.ref_elem.querySelector('[data-bfid="<bfid>"]'); }
    bc_<bfid>_<attr>(data) { ... }       // attr expression body, destructured from data
    bc_ce_<attr>(data) { ... }           // for definition-root attrs (no bfid; target is this.ref_elem)
    bc_print_<startId>(data) { ... }     // print expression body (keyed off the leading marker id)
    branch_<setId>(data) { ... }         // → active branch index, or -1 when none matches
    getCreatePatchBranch_<setId>(i, data) { ... }   // lazily build + memoize the child for branch i
    renderIf_<setId>(data) { ... }       // swap + create child, returns true iff it re-rendered
    replaceBetween(parent, startMarker, endMarker, node) { ... }   // emitted for print sites and if-sets
    mutate_<varName>(data) { ... }       // set handling first, then sel + bc + setAttribute / replaceBetween
    update(varName, data) { switch(varName) { case '<v>': this.mutate_<v>(data); ... } }
}
// ...one class per nested branch: BackflipPatch_<setId>_<branchIndex>, not exported...

export class BackflipMyElement {
    constructor(ce) { this.ce = ce; this.pb = new BackflipPatch_MyElement(this.ce, this.collectData()); }
    collectData() { return { title: ..., flag: ... }; }
    update(varName) { this.pb.update(varName, this.collectData()); }
}
```

Only `BackflipMyElement` is exported (the auto-included entry references it); the `BackflipPatch_*` classes are module-private.

Inside a `mutate_<varName>` body, **set handling runs first** (see [Ordering](#ordering-within-mutate_var)): for each owned set driven by the var, `mutate_` either calls `this.renderIf_<setId>(data)` (the var is in a branch condition), forwards the change to the active child — `const pb = this.if_pb_<setId>.get(this.if_<setId>); if (pb) pb.update('<var>', data);` — or does both under an `if (!this.renderIf_<setId>(data)) { …forward… }` guard (re-render *or* forward, never both). Then the branch's own sites run, grouped by element: `ref-element` sites (the patch-branch's own ref element — including the custom element for the root) use `elem = this.ref_elem;`; descendant sites use `elem = this.sel_<bfid>();`. Each group is guarded once; a null lookup logs `console.error(...)` and skips, since it means the rendered DOM diverged from the compiled template.

Per-site updates within a found group:

- **attr** → `elem.setAttribute(name, String(...))`, or `setAttribute(name, '')`+`removeAttribute(name)` for booleans.
- **print** → `this.replaceBetween(elem, '<startMarker>', '<endMarker>', document.createTextNode(String(...)))`.

`renderIf_<setId>(data)` resolves the set's target element itself (same null-guard `console.error`), re-renders the winning branch into the marker range via `replaceBetween`, evicts the old branch's child instance, creates the new one, and returns whether it swapped. `replaceBetween(parent, startMarker, endMarker, node)` is the shared marker-range replace: it finds the two marker comments among `parent`'s direct children, removes every node strictly between them, and inserts `node` before the closing marker. Prints pass a text node (never `innerText`/`innerHTML`) so siblings are preserved and the value is never interpreted as markup; if-sets pass the `DocumentFragment` of the freshly rendered branch. Either way the markers survive, so the range stays patchable.

Other notes:

- The **target** of a site is `this.ref_elem` when its nearest enclosing element *is* the patch-branch's ref element (a `b-unwrap b-if` branch anchors content to the element the set sits in; the root's ref element is the custom element itself), otherwise `this.sel_<bfid>()`. A set's target doubles as the `ref_elem` handed to each child branch, which is what makes the child's own targets resolvable.
- `collectData()` (on the shell) returns every declared `b-attr` (string → `getAttribute(name) ?? ''`; bool → `hasAttribute(name)`), and is the only place `collectData` is called — patch-branches receive `data` from their caller.
- A patch-branch's `update` switches over every live var referenced anywhere in its subtree, including vars that appear *only* in a descendant branch (so a change can be forwarded down). This is deliberately over-broad: a var in a non-patchable position (a `b-for` iterable) yields a no-op `mutate_`. Unused live vars still appear in `collectData`, just not in any `update`.
- Boolean dynamic attributes use `setAttribute(name, '')` / `removeAttribute(name)` to match the server-rendered HTML.

## Patch-branches

A **patch-branch** owns patching for a DOM subtree that is either wholly present or wholly absent. It runs from a root element down to — but not including — each nested **qualifying** `b-if` it meets; every branch of that set that owns patchable content becomes its own patch-branch class (`BackflipPatch_<setId>_<branchIndex>`). One class per branch, not per set.

- **Ownership.** A site belongs to the innermost patch-branch containing it. `renderIf_<set>` lives in the parent (it owns the anchor + marker pair), while the branch's content sites live in the child. A non-qualifying nested set is inert client-side, so its content stays owned by the enclosing patch-branch.
- **`ref_elem`.** Each class is constructed with the element it patches against — `this.ce` for the root, and the parent element containing a set for each of that set's child branches. `sel_<bfid>()` is `ref_elem.querySelector(...)`, so every owned site resolves to `ref_elem` or a descendant of it.
- **Forwarding.** A live var change enters through `BackflipMyElement.update` → root `pb.update`. Each patch-branch re-renders the sets it directly owns and forwards the change to the active child for anything deeper, so the change reaches whichever patch-branch actually owns the affected content.
- **Snapshots.** Every set — nested included — gets its own module-level `bfif_<setId>` snapshot; `renderIf_<set>` calls `render(bfif_<set>, data)`. Snapshots are taken only after pass 1 has spliced every marker at every depth, so a re-rendered parent branch still carries the anchors its nested patch-branches need.

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
