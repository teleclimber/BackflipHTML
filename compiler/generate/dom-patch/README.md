# DOM-patch generator

Produces one JavaScript module per custom-element partial that asks for client JS with [`b-generate`](../../../docs/partials.md#generated-client-js-b-generate). Each module holds an exported `BackflipMyElement` shell plus a tree of module-private **patch-branch** classes, which let browser-side code update specific attributes, prints, and `b-if` branches of the rendered subtree when one of the custom element's own attributes changes — without re-rendering the whole thing. See [patch-branches](#patch-branches). For `b-generate="base"` and `"full"` the module also carries the [custom element class](#the-custom-element-class) that drives the shell.

Modules are written flat at the dom-patch output root, named after the partial's tag (`my-widget.js`). One partial per module keeps the auto-include kind unambiguous — a `full` partial's module is executed, a `base` partial's is preloaded — and means a page only loads the elements it rendered. It is also why a partial that generates JS must have a project-unique tag name.

## How it fits

Unlike the [`js/`](../js/README.md) and [`php/`](../php/README.md) generators (which only read the AST), dom-patch **mutates** the un-flattened AST on its way through. For every qualifying attribute site it appends a `data-bfid="..."` static attribute to the owning element so the runtime class can find it via `querySelector`. For a qualifying `{{ print }}` it inserts a pair of marker **comment** nodes around the print (and a `data-bfid` on the parent element). The mutated AST then flows to the other generators, so the server-rendered HTML carries the same markers.

Because of this, the CLI calls `applyDomPatch()` on each `CompiledFile` **before** running flatten + js/php codegen. The preview server does the same before rendering (see `preview/preview.ts`), so previewed HTML carries the same `data-bfid` markers as a real build.

## What qualifies

Five site flavors are emitted:

- **`attr`** — a `b-bind:`/`:` dynamic attribute on an element inside the partial body. The owning element gets a `data-bfid` so the runtime can find it via `querySelector`.
- **`caller-attr-expr`** — a `b-bind:`/`:` dynamic attribute on a **nested custom-element call** inside the partial body (e.g. `<child-el :show="show">` inside `parent-el`). The call renders as a real element, so the attribute is patched with `setAttribute` on it — exactly like an `attr` site — and the nested custom element observes the change and re-patches its own subtree. A `data-bfid` is stamped into the call's `callerAttrs` (merged into the rendered open tag); multiple dynamic caller attrs on the same call share one `data-bfid`. This is what lets a live var flow from a parent custom element down into a child custom element's attribute.
- **`definition-root-attr`** — a `b-bind:`/`:` dynamic attribute on the partial's own wrapping tag (i.e. the custom element itself). No `data-bfid` is added — it resolves to the owning patch-branch's `ref_elem`, which for the root is the custom element (`this.ce`).
- **`print`** — a `{{ expr }}` interpolation. The print is bracketed by two marker comment nodes (`<!--bfid:<id>-->`), and its parent element gets a `data-bfid`. When that parent *is* the owning patch-branch's ref element (a print directly inside the custom element, or in a `b-unwrap` branch), no `data-bfid` is added and it targets `ref_elem`. `b-if` / `b-for` wrappers are DOM-transparent, so the "parent element" is the nearest enclosing real element and the markers are inserted as immediate siblings of the print (inside the branch).
- **`if-set`** — a whole `b-if` / `b-else-if` / `b-else` set, tracked as **one** site (not one per branch). Anchored exactly like a print: a marker pair brackets the `IfTNode` in its container array, and the nearest enclosing element gets a `data-bfid` (or it targets the owning patch-branch's `ref_elem`). Unlike the other flavors this one generates *new DOM* in the browser — see [b-if sets](#b-if-sets) below.

A site qualifies when **all** of these hold:

- The owning partial is a **custom-element partial** (`b-attr:` declarations are the source of "live" variables).
- For attrs (element and caller): the attribute is a `b-bind:`/`:` dynamic attribute (a `Parsed` expression in `AttrPart.dynamic.expr`). For prints: the `{{ expr }}`'s `Parsed`. For if-sets: every branch condition.
- The expression parses and names at least one variable. A variable-free expression can never change, so it is not a patch site. Its variables need no check: the compiler rejects a partial that generates JS and reads anything it does not declare, so every variable here is a `b-attr` that `collectData()` returns.
- The site is **not** inside a `b-for` loop. (v1 limitation — see below.)
- For caller attrs: the attribute is **not** asset-bearing (`isAsset`), since the browser has no asset map.

Sites that don't qualify are silently ignored: `b-for` iterables and `b-data:` bindings. Static caller attrs are not patched. Slot contents are not entered (they live in the caller's scope). A `b-part` call inlines its partial with no stable element, so nothing on it is patchable.

A partial with no `b-generate` (and no `b-script` implying one) is skipped entirely. In `render` mode a partial with no qualifying site produces nothing; in `base` and `full` the module is emitted anyway, since the author asked for a class whether or not it patches.

## v1 limitation: no for-loop sites

Sites whose ancestor chain contains a `ForTNode` are skipped (attrs, prints and if-sets alike). The bfid mechanism relies on `querySelector`, which returns only the first match — so a site on a `b-for`'d element would only update one of N rendered copies. This is documented rather than worked around; an explicit error is not raised (it's a silent skip, as for any non-qualifying site).

No `b-for` can currently reach here from valid source: a loop needs an iterable, a generating partial reads only its declared attributes, and a `b-attr` used as an iterable is a compile error. The loop handling — the skip, the subtree walk, and the value-name scoping in `computeSubtreeVars` — is kept because a declared input that is a collection is what makes `b-for` meaningful, and the `querySelector` problem above is what will then need solving.

Other deliberate limitations, all covered above: patch sites inside an inactive branch of a **non-qualifying** nested set log `console.error` on every mutate (only qualifying sets get the patch-branch treatment that avoids this); `<script>` tags inside a branch do not execute when inserted via a fragment; and the initial active index is recomputed and trusted to match the server render. Nested `b-if` **is** supported — see [patch-branches](#patch-branches).

## b-if sets

Attr and print patching edits DOM that is already there. An if-set instead **renders new DOM** when a different branch wins: the generated module ships a snapshot of the whole set as an RNode literal (the same data shape `generate/js` emits, produced by `nodeToJS`), calls the JS runtime's `render()` on it, and swaps the result into the marker range.

Three consequences shape the design:

- **`render.js` is a build input.** The generated module imports `render` and `activeBranchIndex` from `./render.js`. See [Runtime files](#runtime-files) for how it reaches the output dir.
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

Each patch-branch's constructor computes every owned set's active branch index from the data it's handed — with the runtime's `activeBranchIndex(bfif_<setId>, data)`, the same choice `render()` makes, so the conditions are evaluated from the snapshot rather than generated a second time — and stores it in `this.if_<setId>` — it **does not render**, since the server already emitted the right branch. It also seeds `this.if_pb_<setId>` (a branch-index → child-patch-branch map) and eagerly constructs the child for the active branch. The index is `0…n-1` for the winning branch, `-1` when nothing matches (a set with no `b-else` whose conditions are all falsy). The recomputed index is trusted to match the server render; if it doesn't, the DOM stays stale until the index changes.

### Additional qualification rules

Beyond the cross-kind rules, an if-set qualifies only when all of these hold. Any failure disqualifies the **entire set** (all branches), silently:

1. Every branch condition parses and names **at least one** variable.
2. Every expression **anywhere in the subtree** parses — prints, dynamic attrs, nested `b-if` conditions, nested `b-for` iterables.
3. No **partial references** of any kind in the subtree — no `b-part` calls, no custom-element calls.
4. No **slot** nodes in the subtree.
5. No **asset references** in the subtree: no unresolved `asset` AttrPart, no dynamic attr with `isAsset`, no static attr whose raw text contains an `@name/` reference. (The browser has no asset map.)

Nesting is allowed: a qualifying set may sit inside another. Because the rules walk the **whole** subtree, a disqualifier inside a nested set (a partial ref, a slot) sinks the enclosing set too — so a qualifying parent only ever contains nested sets that themselves qualify or are var-free (`b-if="1 == 1"`, which can't be its own patch site but doesn't disqualify anyone). A nested `b-for` is rendered statically as part of the branch that owns it and is not a patch site.

### Ordering within `mutate_<var>`

Within a single patch-branch, if-set handling runs **first** in a `mutate_<var>` body, before that branch's own attr/print mutations. A re-render replaces a whole subtree, so any local site must be patched against the DOM that results. There is no longer a cross-boundary hazard: a patch-branch never owns a site that lives inside a branch it re-renders — those sites belong to the child patch-branch, which is (re)built by the swap. A non-qualifying nested set is the exception: its content stays parent-owned, so a site in its inactive branch is not found and `console.error`s through the null guard.

## Generated class shape

The mutation logic lives in **patch-branches** (see [patch-branches](#patch-branches)); `BackflipMyElement` is a thin shell that owns the host, `collectData()`, and the root patch-branch. For a partial `my-element` with live vars `title` and `flag`:

```js
import { render, activeBranchIndex, execFn } from './render.js';   // each as needed: an if-set; any site
import { replaceBetween, BackflipElement } from './patch.js';      // each as needed: a print or if-set; base/full

const bfif_<setId> = { type:'if', branches: [ ... ] };   // one per if-set, module level
const bc_<bfid>_<attr> = { fn: function (title) { return title; }, vars: ['title'] };   // one per site, module level

class BackflipPatch_MyElement {          // one patch-branch class per qualifying branch
    constructor(ref_elem, data) { this.ref_elem = ref_elem; /* + per-set seeding */ }
    sel_<bfid>() { return this.ref_elem.querySelector('[data-bfid="<bfid>"]'); }
    getCreatePatchBranch_<setId>(i, data) { ... }   // lazily build + memoize the child for branch i
    renderIf_<setId>(data) { ... }       // swap + create child, returns true iff it re-rendered
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

`BackflipMyElement` is exported; the `BackflipPatch_*` classes are module-private. `b-generate="base"` and `"full"` append `BackflipMyElementElement` (also exported) and, for `"full"`, the `customElements.define` call — see [the custom element class](#the-custom-element-class).

Inside a `mutate_<varName>` body, **set handling runs first** (see [Ordering](#ordering-within-mutate_var)): for each owned set driven by the var, `mutate_` either calls `this.renderIf_<setId>(data)` (the var is in a branch condition), forwards the change to the active child — `const pb = this.if_pb_<setId>.get(this.if_<setId>); if (pb) pb.update('<var>', data);` — or does both under an `if (!this.renderIf_<setId>(data)) { …forward… }` guard (re-render *or* forward, never both). Then the branch's own sites run, grouped by element: `ref-element` sites (the patch-branch's own ref element — including the custom element for the root) use `elem = this.ref_elem;`; descendant sites use `elem = this.sel_<bfid>();`. Each group is guarded once; a null lookup logs `console.error(...)` and skips, since it means the rendered DOM diverged from the compiled template.

Per-site updates within a found group:

Each site's expression is a module-level `bc_*` constant in the same `rfn` shape the snapshots use, evaluated with the runtime's `execFn(bc_*, data)` — the renderer's own evaluator. It is named `bc_<bfid>_<attr>` for an attr or caller attr, `bc_ce_<attr>` for a definition-root attr (no bfid; the target is `this.ref_elem`), and `bc_print_<startId>` for a print (keyed off its leading marker id).

- **attr** / **caller-attr-expr** → `elem.setAttribute(name, String(...))`, or `setAttribute(name, '')`+`removeAttribute(name)` for booleans. (Both resolve `elem` by `data-bfid`; a caller-attr's `elem` is the nested custom-element call's rendered tag.)
- **print** → `replaceBetween(elem, '<startMarker>', '<endMarker>', document.createTextNode(String(...)))`.

`renderIf_<setId>(data)` resolves the set's target element itself (same null-guard `console.error`), re-renders the winning branch into the marker range via `replaceBetween`, evicts the old branch's child instance, creates the new one, and returns whether it swapped. `replaceBetween(parent, startMarker, endMarker, node)`, imported from the runtime's `patch.js`, is the shared marker-range replace: it finds the two marker comments among `parent`'s direct children, removes every node strictly between them, and inserts `node` before the closing marker. Prints pass a text node (never `innerText`/`innerHTML`) so siblings are preserved and the value is never interpreted as markup; if-sets pass the `DocumentFragment` of the freshly rendered branch. Either way the markers survive, so the range stays patchable.

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

The bfid and the `bc_*` constant name must be valid JS identifiers, but the runtime DOM call must use the original (stripped) attribute name. So `data-foo` becomes `bc_<bfid>_data_foo` in the constant's name but stays `'data-foo'` in `setAttribute`.

## The custom element class

`b-generate="base"` and `"full"` add `export class BackflipMyWidgetElement` below the shell; `"full"` also adds a guarded `customElements.define('my-widget', BackflipMyWidgetElement)`. The element class is the lifecycle half and does nothing else — it constructs the shell and forwards attribute changes to it. The lifecycle is the same for every partial, so it lives in the runtime's `BackflipElement` (in `patch.js`, an `HTMLElement` subclass), and the generated class only names its shell and declared attributes:

```js
import { BackflipElement } from './patch.js';

export class BackflipMyWidgetElement extends BackflipElement {
    static bfShell = BackflipMyWidget;
    static bfDeclared = ['count'];     // omitted when the partial declares no b-attr
}
```

`BackflipElement` derives `observedAttributes` from `bfDeclared` and, on init, constructs `bfShell` with the element. Each rule it is built around comes from the custom elements spec, not from preference:

- **Nothing happens in the constructor.** A custom element constructor may not inspect its attributes or children, which is exactly what the shell does. There is no constructor at all; `bfInit()` runs from `connectedCallback`.
- **`connectedCallback` can run mid-parse**, when the element's children do not exist yet. `bfInit` checks `ownerDocument.readyState === 'loading'` and, in that case, waits for `DOMContentLoaded` instead of patching into a half-built subtree. It is also idempotent, since moving an element re-fires `connectedCallback`.
- **`attributeChangedCallback` fires before `connectedCallback`**, once per observed attribute, during upgrade. Those calls must not patch — the server-rendered DOM already matches — so they are collected in `bfPending` and replayed by `bfInit`, which fixes an attribute that genuinely changed between parse and upgrade. A change with `oldValue === newValue` is skipped, since `setAttribute` fires the callback either way.
- **`observedAttributes` and the lifecycle callbacks are read once**, at `define()` time, off the registered class. A `base` subclass that overrides `observedAttributes` without spreading `super.observedAttributes` silently loses all reactivity, so `bfInit` compares the two and `console.error`s the missing names. A forgotten `super.connectedCallback()` is documented, not detectable.
- **Everything the class owns is `bf`-prefixed** (`bfPatch`, `bfPending`, `bfInit`, `bfCheckObserved`, and the statics `bfShell` and `bfDeclared`), leaving the plain namespace to a subclass.
- **The define is guarded** with `customElements.get`: a name may be registered once, and an unguarded throw would take the rest of the module with it.

Known limitation: the replay covers attr and print sites, but not an if-set whose condition changed before init — the patch-branch constructor computes the active index from current data and trusts the server to have rendered that branch (the same assumption noted for [active-branch tracking](#active-branch-tracking)).

Patching targets server-rendered DOM, so an element created with `document.createElement` has nothing to patch; that is documented as unsupported. No shadow root is ever attached.

## Entry point

Every var reaching codegen must be one of the partial's declared attributes; the generator asserts this before emitting a module, since a name that slipped through would compile into a patch writing `undefined` into the page.

`applyDomPatch(file, opts?)` mutates the CompiledFile in place and returns `{ modules }` — one `{ tagName, js, runtimeFiles }` per partial in the file that generates client JS. `runtimeFiles` lists the [runtime files](#runtime-files) the module imports. `moduleFileName(tagName)` names its file. `opts` is `{ bfidGen?, scriptUrlFor? }`:

- `bfidGen` — deterministic id generator (`makeSequentialBfidGen()`) in tests; production uses the default crypto-random generator. One generator is shared across a file's partials, so ids stay distinct across its modules.
- `scriptUrlFor(tagName)` — public URL of that partial's module. When it returns a URL, the partial's root is stamped with a script the renderer auto-includes: an `'entry'` for `b-generate="full"` (the module registers the element itself), a `'dependency'` otherwise. Partials that produce no module are left untouched. When the option is absent, generation is unchanged and nothing is stamped.

## Runtime files

Generated modules import shared code instead of carrying a copy of it:

- `render.js` — the JS runtime (`runtime/js/render.ts`), for evaluating a site's expression and for choosing and re-rendering an if-set branch.
- `patch.js` — browser-only code for patching (`runtime/dom-patch/patch.ts`): `replaceBetween`, and the `BackflipElement` base class every `base`/`full` element class extends.

Each module imports only what it calls, and reports those files in `runtimeFiles`. The CLI copies each needed file from `dist` (see `RUNTIME_FILE_DIST_PATHS`) into the root of the dom-patch output dir. Every module sits at that root, so a specifier is always `./<file>`. If a needed `dist` file is missing the build **errors and stops**, since a silent skip would ship a page that 404s on import. The preview server maps `<domPatchOutputDir>/<file>` to the same `dist` file.

## Script auto-include

The stamped script flows through the JS and PHP generators into the emitted root node, and the **renderer** auto-includes the scripts of the custom-element partials it actually renders — there is no manual `<script>` step. The CLI derives each module's URL from the asset prefix that covers the dom-patch output dir (see [Assets](../../../docs/assets.md) and [Configuration](../../../docs/configuration.md)); if no asset prefix covers the output dir it warns and the scripts are not auto-included.

Inclusion follows what actually rendered server-side: a custom element in an untaken `b-if`/`b-else` branch, or a `b-for` over an empty iterable, contributes no script. Reactive `b-if` sets do toggle branches client-side, but this stays correct because **a branch containing a partial reference of any kind disqualifies its whole set** (see [b-if sets](#b-if-sets)). So a branch that is untaken server-side can never later introduce a custom element whose script was not included — any set that could do that is not reactive in the first place.
