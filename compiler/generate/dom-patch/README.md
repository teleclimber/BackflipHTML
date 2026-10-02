# DOM-patch generator

Produces one JavaScript module per custom-element partial that asks for client JS with `b-generate` (author docs: [Client-side patching](../../../docs/dom-patch.md)). The module describes, as data, the specific attributes, prints and `b-if` branches of the rendered subtree that depend on the custom element's own attributes; a shared browser [runtime](#runtime) patches exactly those when an attribute changes — without re-rendering the whole thing. Its exported `BackflipMyElement` shell carries the description as a tree of **patch-branch** descriptors; see [patch-branches](#patch-branches). For `b-generate="base"` and `"full"` the module also carries the [custom element class](#the-custom-element-class) that drives the shell.

Modules are written flat at the dom-patch output root, named after the partial's tag (`my-widget.js`). One partial per module keeps the auto-include kind unambiguous — a `full` partial's module is executed, a `base` partial's is preloaded — and means a page only loads the elements it rendered. It is also why a partial that generates JS must have a project-unique tag name.

## How it fits

Unlike the [`js/`](../js/README.md) and [`php/`](../php/README.md) generators (which only read the AST), dom-patch **mutates** the un-flattened AST on its way through. For every qualifying attribute site it appends a `data-bfid="..."` static attribute to the owning element so the runtime can find it via `querySelector`. For a qualifying `{{ print }}` it inserts a pair of marker **comment** nodes around the print (and a `data-bfid` on the parent element). The mutated AST then flows to the other generators, so the server-rendered HTML carries the same markers.

Because of this, the CLI calls `applyDomPatch()` on each `CompiledFile` **before** running flatten + js/php codegen. The preview server does the same before rendering (see `preview/preview.ts`), so previewed HTML carries the same `data-bfid` markers as a real build.

## What qualifies

Five site flavors are emitted:

- **`attr`** — a `b-bind:`/`:` dynamic attribute on an element inside the partial body. The owning element gets a `data-bfid` so the runtime can find it via `querySelector`.
- **`caller-attr-expr`** — a `b-bind:`/`:` dynamic attribute on a **nested custom-element call** inside the partial body (e.g. `<child-el :show="show">` inside `parent-el`). The call renders as a real element, so the attribute is patched with `setAttribute` on it — exactly like an `attr` site — and the nested custom element observes the change and re-patches its own subtree. A `data-bfid` is stamped into the call's `callerAttrs` (merged into the rendered open tag); multiple dynamic caller attrs on the same call share one `data-bfid`. This is what lets a live var flow from a parent custom element down into a child custom element's attribute.
- **`definition-root-attr`** — a `b-bind:`/`:` dynamic attribute on the partial's own wrapping tag (i.e. the custom element itself). No `data-bfid` is added — it resolves to the owning patch-branch's ref element, which for the root is the custom element.
- **`print`** — a `{{ expr }}` interpolation. The print is bracketed by two marker comment nodes (`<!--bfid:<id>-->`), and its parent element gets a `data-bfid`. When that parent *is* the owning patch-branch's ref element (a print directly inside the custom element, or in a `b-unwrap` branch), no `data-bfid` is added and it targets the ref element. `b-if` / `b-for` wrappers are DOM-transparent, so the "parent element" is the nearest enclosing real element and the markers are inserted as immediate siblings of the print (inside the branch).
- **`if-set`** — a whole `b-if` / `b-else-if` / `b-else` set, tracked as **one** site (not one per branch). Anchored exactly like a print: a marker pair brackets the `IfTNode` in its container array, and the nearest enclosing element gets a `data-bfid` (or it targets the owning patch-branch's ref element). Each branch's content also opens with a **branch marker** (`<!--bfid:<setId>:<index>-->`), so the rendered DOM shows which branch won. Unlike the other flavors this one generates *new DOM* in the browser — see [b-if sets](#b-if-sets) below.

A site qualifies when **all** of these hold:

- The owning partial is a **custom-element partial** (`b-attr:` declarations are the source of "live" variables).
- For attrs (element and caller): the attribute is a `b-bind:`/`:` dynamic attribute (a `Parsed` expression in `AttrPart.dynamic.expr`). For prints: the `{{ expr }}`'s `Parsed`. For if-sets: every branch condition.
- The expression parses and names at least one variable. A variable-free expression can never change, so it is not a patch site. Its variables need no check: the compiler rejects a partial that generates JS and reads anything it does not declare, so every variable here is a `b-attr` the shell reads off the element.
- The site is **not** inside a `b-for` loop. (v1 limitation — see below.)
- For caller attrs: the attribute is **not** asset-bearing (`isAsset`), since the browser has no asset map.

Sites that don't qualify are silently ignored: `b-for` iterables and `b-data:` bindings. Static caller attrs are not patched. Slot contents are not entered (they live in the caller's scope). A `b-part` call inlines its partial with no stable element, so nothing on it is patchable.

A partial with no `b-generate` (and no `b-script` implying one) is skipped entirely. In `render` mode a partial with no qualifying site produces nothing; in `base` and `full` the module is emitted anyway, since the author asked for a class whether or not it patches.

## v1 limitation: no for-loop sites

Sites whose ancestor chain contains a `ForTNode` are skipped (attrs, prints and if-sets alike). The bfid mechanism relies on `querySelector`, which returns only the first match — so a site on a `b-for`'d element would only update one of N rendered copies. This is documented rather than worked around; an explicit error is not raised (it's a silent skip, as for any non-qualifying site).

No `b-for` can currently reach here from valid source: a loop needs an iterable, a generating partial reads only its declared attributes, and a `b-attr` used as an iterable is a compile error. The loop handling — the skip, the subtree walk, and the value-name scoping in `computeSubtreeVars` — is kept because a declared input that is a collection is what makes `b-for` meaningful, and the `querySelector` problem above is what will then need solving.

Other deliberate limitations, all covered above: patch sites inside an inactive branch of a **non-qualifying** nested set log `console.error` on every update (only qualifying sets get the patch-branch treatment that avoids this); and `<script>` tags inside a branch do not execute when inserted via a fragment. Nested `b-if` **is** supported — see [patch-branches](#patch-branches).

## b-if sets

Attr and print patching edits DOM that is already there. An if-set instead **renders new DOM** when a different branch wins: the generated module ships a snapshot of the whole set as an RNode literal (the same data shape `generate/js` emits, produced by `nodeToJS`), calls the JS runtime's `render()` on it, and swaps the result into the marker range.

Three consequences shape the design:

- **The runtime renders the branch** with the JS runtime's `render()`, from the snapshot the module carries. See [Runtime](#runtime).
- **Snapshots are taken after all AST mutation, recursively.** `applyDomPatch` runs two passes per partial over the patch-branch tree (see [patch-branches](#patch-branches)): pass 1 mutates the AST at every depth (`data-bfid`s, print markers, and every set's marker pair and branch markers), pass 2 snapshots each set's `IfTNode`. Taking a snapshot before every nested marker exists would produce a client-rendered branch missing markers the server-rendered HTML has, and every patch site inside it — including a nested set's anchors — would stop working.
- **The HTML becomes DOM via `range.createContextualFragment()`**, with the range's contents set to the target element, so a branch is parsed in its real parent context (a `<tr>` under a `<tbody>` survives).

### Trigger variables

An if-set is re-rendered (its branch swapped) **only by the live vars in its own branch conditions**. But a var referenced deeper — in a nested set's condition, or in branch content — still needs to reach that content. A patch-branch therefore also tracks the live vars anywhere in its subtree and **forwards** a change down to the active child patch-branch, which either re-renders its own nested set or patches its own sites. So a nested `b-if` whose condition changes while the outer condition is unchanged **does** re-render (via forwarding):

```html
<div b-if="a">
  <p b-if="b">…</p>   <!-- changing `b` re-renders just this inner branch -->
</div>
```

### Active-branch tracking

When a patch-branch is constructed it reads every owned set's active branch index **from the DOM**: the branch marker between the set's markers names the branch the server rendered. It does not compute the index from data, since an attribute may have changed between the render and init; the next update that recomputes the index then swaps in the branch the data now picks. Construction **does not render**. It also constructs the patch-branch for the active branch; branches swapped in later get theirs when they are rendered. The index is `0…n-1` for the winning branch, `-1` when nothing matches (a set with no `b-else` whose conditions are all falsy), which the DOM shows as no branch marker. A client-rendered branch carries its marker too, since the snapshot includes it.

### Additional qualification rules

Beyond the cross-kind rules, an if-set qualifies only when all of these hold. Any failure disqualifies the **entire set** (all branches), silently:

1. Every branch condition parses and names **at least one** variable.
2. Every expression **anywhere in the subtree** parses — prints, dynamic attrs, nested `b-if` conditions, nested `b-for` iterables.
3. No **partial references** of any kind in the subtree — no `b-part` calls, no custom-element calls.
4. No **slot** nodes in the subtree.
5. No **asset references** in the subtree: no unresolved `asset` AttrPart, no dynamic attr with `isAsset`, no static attr whose raw text contains an `@name/` reference. (The browser has no asset map.)

Nesting is allowed: a qualifying set may sit inside another. Because the rules walk the **whole** subtree, a disqualifier inside a nested set (a partial ref, a slot) sinks the enclosing set too — so a qualifying parent only ever contains nested sets that themselves qualify or are var-free (`b-if="1 == 1"`, which can't be its own patch site but doesn't disqualify anyone). A nested `b-for` is rendered statically as part of the branch that owns it and is not a patch site.

### Ordering within an update

Within a single patch-branch, if-set handling runs **first** on an update, before that branch's own attr/print sites. A re-render replaces a whole subtree, so any local site must be patched against the DOM that results. There is no longer a cross-boundary hazard: a patch-branch never owns a site that lives inside a branch it re-renders — those sites belong to the child patch-branch, which is (re)built by the swap. A non-qualifying nested set is the exception: its content stays parent-owned, so a site in its inactive branch is not found and is reported with `console.error`.

## Generated module shape

For a partial `my-element` with live vars `title` and `flag`:

```js
import { BackflipShell, BackflipElement } from './runtime/dom-patch/patch.js';   // BackflipElement for base/full

const bfif_<setId> = { type:'if', branches: [ ... ] };   // one snapshot per if-set, innermost first

export class BackflipMyElement extends BackflipShell {
    static bfAttrs = { title: 'string', flag: 'bool' };   // every declared b-attr
    static bfRoot = {                                     // the root patch-branch
        sites: [
            { bfid: 'bf0', attr: 'title', expr: { fn: function ( title ) { return title; }, vars: ['title'] } },
            { bfid: null, markers: ['bfid:bf1', 'bfid:bf2'], expr: { ... } },   // a print on the element itself
        ],
        sets: [
            { bfid: 'bf3', markers: ['bfid:bf4', 'bfid:bf5'],
                snapshot: bfif_bf4, subtreeVars: ['title'],
                branchMarkers: ['bfid:bf4:0', 'bfid:bf4:1'],
                branches: [ { sites: [ ... ], sets: [ ... ] }, null ] },
        ],
    };
}
```

`b-generate="base"` and `"full"` append `BackflipMyElementElement` and, for `"full"`, the `customElements.define` call — see [the custom element class](#the-custom-element-class). Only these two classes are exported; there is no other generated code.

The descriptors (the runtime's `BranchDesc`, `SetDesc` and `SiteDesc`):

- **`bfid`** locates the element a site or set is anchored to: a descendant of the patch-branch's ref element with that `data-bfid`, or the ref element itself when `null`.
- **An attr site** (`attr`, caller attr, definition-root attr) names the attribute as written, and `bool: true` for a boolean one. Its expression's value is set with `setAttribute(name, String(value))`, or a boolean one is present (`''`) or removed, matching the server-rendered HTML.
- **A print site** names its marker comments. The range between them is replaced with a text node (never markup), so siblings are preserved and the value is never parsed.
- **A set** names its markers, its module-level snapshot, the vars used anywhere in its branch content (`subtreeVars`), each branch's marker (`branchMarkers`), and one descriptor per branch — `null` for a branch with nothing to patch.
- **Expressions** are the same `rfn` literals the JS generator emits, evaluated by the renderer's own `execFn`.

## Patch-branches

A **patch-branch** owns patching for a DOM subtree that is either wholly present or wholly absent. It runs from a root element down to — but not including — each nested **qualifying** `b-if` it meets; every branch of that set that owns patchable content is its own patch-branch, nested in the set's descriptor.

- **Ownership.** A site belongs to the innermost patch-branch containing it. A set belongs to the parent (which owns its anchor and marker pair), while its branches' content sites belong to their own patch-branches. A non-qualifying nested set is inert client-side, so its content stays owned by the enclosing patch-branch.
- **Ref element.** Each patch-branch patches against one element — the custom element for the root, and the element a set is anchored to for each of that set's branches — so every site it owns resolves to that element or a descendant of it.
- **Forwarding.** A change enters through the shell's `update(name)`, which reads the element's attributes and hands them to the root. Each patch-branch re-renders the sets it directly owns whose branch conditions use the var, and forwards the change to the active branch of those whose `subtreeVars` include it — one or the other, never both — so the change reaches whichever patch-branch owns the affected content. Then it patches its own sites that use the var, looking each anchor element up once. `update()` with no name does all of this for every var.
- **Writes only on change.** Each site remembers the value it shows, in DOM form: an attribute's text or presence, or a print's text. It is read from the DOM the first time the site is patched, so the server render (or, for a swapped-in branch, the client render) is the starting point rather than the data. A recomputed value equal to it writes nothing; a set likewise re-renders only when its winning branch changes. Where the server and the JS runtime turn a value into different text (PHP prints a boolean `true` as `1`), the site is rewritten once, at init.
- **Snapshots.** Every set — nested included — gets its own module-level `bfif_<setId>` snapshot, which a swap renders. A snapshot refers to each qualifying set nested in it by that set's `bfif_` name rather than repeating its content (the `ifRef` option of `nodeToJS`), so the consts are emitted innermost-first. A var-free nested `b-if` has no const and stays inline. Snapshots are taken only after pass 1 has spliced every marker at every depth, so a re-rendered parent branch still carries the anchors its nested patch-branches need.

A missing anchor or marker pair means the rendered DOM diverged from the compiled template; it is reported with `console.error` and that patch is skipped.

## The custom element class

`b-generate="base"` and `"full"` add `export class BackflipMyWidgetElement` below the shell; `"full"` also adds a guarded `customElements.define('my-widget', BackflipMyWidgetElement)`. The element class is the lifecycle half and does nothing else — it constructs the shell and forwards attribute changes to it. The lifecycle is the same for every partial, so it lives in the runtime's `BackflipElement` (an `HTMLElement` subclass), and the generated class only names its shell:

```js
export class BackflipMyWidgetElement extends BackflipElement {
    static bfShell = BackflipMyWidget;
}
```

`BackflipElement` observes the shell's declared attributes (`bfShell.bfAttrs`) and, on init, constructs the shell with the element. Each rule it is built around comes from the custom elements spec, not from preference:

- **Nothing happens in the constructor.** A custom element constructor may not inspect its attributes or children, which is exactly what the shell does. There is no constructor at all; `bfInit()` runs from `connectedCallback`.
- **`connectedCallback` can run mid-parse**, when the element's children do not exist yet. `bfInit` checks `ownerDocument.readyState === 'loading'` and, in that case, waits for `DOMContentLoaded` instead of patching into a half-built subtree. It is also idempotent, since moving an element re-fires `connectedCallback`.
- **`attributeChangedCallback` fires before `connectedCallback`**, once per observed attribute, during upgrade, and it reports nothing for an attribute removed before upgrade. So calls before init are ignored, and `bfInit` instead runs one full update: every site and set is recomputed and compared against the DOM, which fixes whatever changed since the server render and writes nothing where the DOM already matches. A change with `oldValue === newValue` is skipped, since `setAttribute` fires the callback either way.
- **`observedAttributes` and the lifecycle callbacks are read once**, at `define()` time, off the registered class. A `base` subclass that overrides `observedAttributes` without spreading `super.observedAttributes` silently loses all reactivity, so `bfInit` compares the two and `console.error`s the missing names. A forgotten `super.connectedCallback()` is documented, not detectable.
- **Everything the class owns is `bf`-prefixed** (`bfPatch`, `bfInit`, `bfCheckObserved`, and the static `bfShell`), leaving the plain namespace to a subclass.
- **The define is guarded** with `customElements.get`: a name may be registered once, and an unguarded throw would take the rest of the module with it.

Patching targets server-rendered DOM, so an element created with `document.createElement` has nothing to patch; that is documented as unsupported. No shadow root is ever attached.

## Entry point

Every var reaching codegen must be one of the partial's declared attributes; the generator asserts this before emitting a module, since a name that slipped through would compile into a patch writing `undefined` into the page.

`applyDomPatch(file, opts?)` mutates the CompiledFile in place and returns `{ modules }` — one `{ tagName, js }` per partial in the file that generates client JS. `moduleFileName(tagName)` names its file. `opts` is `{ bfidGen?, scriptUrlFor? }`:

- `bfidGen` — deterministic id generator (`makeSequentialBfidGen()`) in tests; production uses the default crypto-random generator. One generator is shared across a file's partials, so ids stay distinct across its modules.
- `scriptUrlFor(tagName)` — public URL of that partial's module. When it returns a URL, the partial's root is stamped with a script the renderer auto-includes: an `'entry'` for `b-generate="full"` (the module registers the element itself), a `'dependency'` otherwise. Partials that produce no module are left untouched. When the option is absent, generation is unchanged and nothing is stamped.

## Runtime

Every generated module runs on the same browser runtime, `runtime/dom-patch/patch.ts`: `BackflipShell`, the generic `PatchBranch` that interprets the descriptors, and `BackflipElement`. It imports the JS runtime (`runtime/js/render.ts`) for `render`, `activeBranchIndex` and `execFn`, so a swapped-in branch is rendered, chosen and evaluated exactly as the server does it.

`RUNTIME_FILES` lists both as paths relative to the package's `dist/`. When a build generates any module, the CLI copies each into the dom-patch output dir at that same relative path, so the modules' `./runtime/dom-patch/patch.js` import and patch.js's own import of `../js/render.js` both resolve. If a `dist` file is missing the build **errors and stops**, since a silent skip would ship a page that 404s on import. The preview server maps `<domPatchOutputDir>/<file>` to the same `dist` file.

## Script auto-include

`scriptUrlFor` stamps each generating partial's root with its module's URL and kind; the JS and PHP generators carry the stamp into the emitted root node, and the renderers include the scripts of the custom elements they actually render. The caller supplies the URLs: the CLI derives them from the asset prefix covering the output dir.

Inclusion follows what rendered server-side, yet reactive `b-if` sets toggle branches client-side. This stays correct because **a branch containing a partial reference of any kind disqualifies its whole set** (see [b-if sets](#b-if-sets)): a branch untaken server-side can never later introduce a custom element whose script was not included.
