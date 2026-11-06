# DOM-patch generator

Produces one JavaScript module per custom-element partial that asks for client JS with `b-generate` (author docs: [Client-side patching](../../../docs/dom-patch.md)). The module describes, as data, the specific attributes, prints, `b-if` branches and `b-for` items of the rendered subtree that depend on the custom element's own attributes; a shared browser [runtime](#runtime) patches exactly those when an attribute or store changes — without re-rendering the whole thing. Its exported `BackflipMyElement` shell carries the description as a tree of **patch-branch** descriptors; see [patch-branches](#patch-branches). For `b-generate="base"` and `"full"` the module also carries the [custom element class](#the-custom-element-class) that drives the shell.

Modules are written flat at the dom-patch output root, named after the partial's tag (`my-widget.js`). One partial per module keeps the auto-include kind unambiguous — a `full` partial's module is executed, a `base` partial's is preloaded — and means a page only loads the elements it rendered. It is also why a partial that generates JS must have a project-unique tag name.

## How it fits

Unlike the [`js/`](../js/README.md) generator (which only reads the AST), dom-patch **mutates** the un-flattened AST on its way through. For every qualifying attribute site it appends a `data-bfid="..."` static attribute to the owning element so the runtime can find it via `querySelector`. For a qualifying `{{ print }}` it inserts a pair of marker **comment** nodes around the print (and a `data-bfid` on the parent element). The mutated AST then flows to the JS generator, so the server-rendered HTML carries the same markers.

Because of this, the CLI calls `applyDomPatch()` on each `CompiledFile` **before** running flatten + js codegen. The preview server does the same before rendering (see `preview/preview.ts`), so previewed HTML carries the same `data-bfid` markers as a real build.

## Patching owns its DOM

The server generates the HTML and the data together, so they match when the page loads. Dom-patch is designed on the assumption that they stay matched: after that, only patching changes the DOM it manages. Author code changes a partial through its inputs, its declared attributes and stores, and [the author docs](../../../docs/dom-patch.md#scripts-and-patched-dom) tell authors not to change that DOM directly.

Handling scripts that break this rule is a non-goal, so don't add machinery to detect or repair their changes. The `console.error` reports for a missing or duplicated anchor are diagnostics, and comparing against the DOM at init is not a guarantee to authors.

## What qualifies

Six site flavors are emitted:

- **`attr`** — a `b-bind:`/`:` dynamic attribute on an element inside the partial body. The owning element gets a `data-bfid` so the runtime can find it via `querySelector`.
- **`caller-attr-expr`** — a `b-bind:`/`:` dynamic attribute on a **nested custom-element call** inside the partial body (e.g. `<child-el :show="show">` inside `parent-el`). The call renders as a real element, so the attribute is patched with `setAttribute` on it — exactly like an `attr` site — and the nested custom element observes the change and re-patches its own subtree. A `data-bfid` is stamped into the call's `callerAttrs` (merged into the rendered open tag); multiple dynamic caller attrs on the same call share one `data-bfid`. This is what lets a live var flow from a parent custom element down into a child custom element's attribute.
- **`definition-root-attr`** — a `b-bind:`/`:` dynamic attribute on the partial's own wrapping tag (i.e. the custom element itself). No `data-bfid` is added — it resolves to the owning patch-branch's ref element, which for the root is the custom element.
- **`print`** — a `{{ expr }}` interpolation. The print is bracketed by two marker comment nodes (`<!--bfid:<id>-->`), and its parent element gets a `data-bfid`. When that parent *is* the owning patch-branch's ref element (a print directly inside the custom element, or in a `b-unwrap` branch), no `data-bfid` is added and it targets the ref element. `b-if` / `b-for` wrappers are DOM-transparent, so the "parent element" is the nearest enclosing real element and the markers are inserted as immediate siblings of the print (inside the branch).
- **`if-set`** — a whole `b-if` / `b-else-if` / `b-else` set, tracked as **one** site (not one per branch). Anchored exactly like a print: a marker pair brackets the `IfTNode` in its container array, and the nearest enclosing element gets a `data-bfid` (or it targets the owning patch-branch's ref element). Each branch's content also opens with a **branch marker** (`<!--bfid:<setId>:<index>-->`), so the rendered DOM shows which branch won. Unlike the attr and print flavors this one generates *new DOM* in the browser — see [b-if sets](#b-if-sets) below.
- **`loop`** — a whole `b-for`, tracked as one site. Anchored like an if-set: a marker pair brackets the `ForTNode`, and each item's content opens with an **item marker** (`<!--bfitem:<loopId>-->`). It generates new DOM too — see [b-for loops](#b-for-loops) below.

A site qualifies when **all** of these hold:

- The owning partial is a **custom-element partial** (`b-attr:` declarations are the source of "live" variables).
- For attrs (element and caller): the attribute is a `b-bind:`/`:` dynamic attribute (a `Parsed` expression in `AttrPart.dynamic.expr`). For prints: the `{{ expr }}`'s `Parsed`. For if-sets: every branch condition. For loops: the iterable.
- The expression parses and names at least one variable. A variable-free expression can never change, so it is not a patch site. Its variables need no check: the compiler rejects a partial that generates JS and reads anything it does not declare, so every variable here is a declared input, or a name an enclosing loop binds.
- The site is **not** inside a non-qualifying `b-for` loop, whose copies can't be told apart.
- For caller attrs: the attribute is **not** asset-bearing (`isAsset`), since the browser has no asset map.

Sites that don't qualify are silently ignored, as are `b-data:` bindings. Static caller attrs are not patched. Slot contents are not entered (they live in the caller's scope). A `b-part` call inlines its partial with no stable element, so nothing on it is patchable.

A partial with no `b-generate` (and no `b-script` implying one) is skipped entirely. In `render` mode a partial with no qualifying site produces nothing; in `base` and `full` the module is emitted anyway, since the author asked for a class whether or not it patches.

## Limitations

Deliberate limitations, all covered elsewhere here: patch sites inside an inactive branch of a **non-qualifying** nested set log `console.error` on every update (only qualifying sets get the patch-branch treatment that avoids this); and `<script>` tags inside a branch do not execute when inserted via a fragment. Nested `b-if` **is** supported — see [patch-branches](#patch-branches).

## b-if sets

Attr and print patching edits DOM that is already there. An if-set instead **renders new DOM** when a different branch wins: the generated module ships a snapshot of the whole set as an RNode literal (the same data shape `generate/js` emits, produced by `nodeToJS`), calls the JS runtime's `render()` on it, and swaps the result into the marker range.

Three consequences shape the design:

- **The runtime renders the branch** with the JS runtime's `render()`, from the snapshot the module carries. See [Runtime](#runtime).
- **Snapshots are taken after all AST mutation, recursively.** `applyDomPatch` runs two passes per partial over the patch-branch tree (see [patch-branches](#patch-branches)): pass 1 mutates the AST at every depth (`data-bfid`s, print markers, and every set's marker pair and branch markers), pass 2 snapshots each set's `IfTNode`. Taking a snapshot before every nested marker exists would produce a client-rendered branch missing markers the server-rendered HTML has, and every patch site inside it — including a nested set's anchors — would stop working.
- **The HTML becomes DOM via `range.createContextualFragment()`**, with the range's contents set to the target element, so a branch is parsed in its real parent context (a `<tr>` under a `<tbody>` survives).

### Active-branch tracking

When a patch-branch is constructed it reads every owned set's active branch index **from the DOM**: the branch marker between the set's markers names the branch the server rendered. It does not compute the index from data, since an attribute may have changed between the render and init; the next update then swaps in the branch the data now picks. Construction **does not render**. It also constructs the patch-branch for the active branch; branches swapped in later get theirs when they are rendered. The index is `0…n-1` for the winning branch, `-1` when nothing matches (a set with no `b-else` whose conditions are all falsy), which the DOM shows as no branch marker. A client-rendered branch carries its marker too, since the snapshot includes it.

### Additional qualification rules

Beyond the cross-kind rules, an if-set qualifies only when all of these hold. Any failure disqualifies the **entire set** (all branches), silently:

1. Every branch condition parses and names **at least one** variable.
2. Every expression **anywhere in the subtree** parses — prints, dynamic attrs, nested `b-if` conditions, nested `b-for` iterables.
3. No **partial references** of any kind in the subtree — no `b-part` calls, no custom-element calls.
4. No **slot** nodes in the subtree.
5. No **asset references** in the subtree: no unresolved `asset` AttrPart, no dynamic attr with `isAsset`, no static attr whose raw text contains an `@name/` reference. (The browser has no asset map.)

Nesting is allowed: a qualifying set may sit inside another. Because the rules walk the **whole** subtree, a disqualifier inside a nested set (a partial ref, a slot) sinks the enclosing set too — so a qualifying parent only ever contains nested sets that themselves qualify or are var-free (`b-if="1 == 1"`, which can't be its own patch site but doesn't disqualify anyone). A qualifying nested `b-for` is a loop of the branch that owns it.

### Ordering within an update

Within a single patch-branch, if-set handling runs **first** on an update, before that branch's own attr/print sites. A re-render replaces a whole subtree, so any local site must be patched against the DOM that results. There is no longer a cross-boundary hazard: a patch-branch never owns a site that lives inside a branch it re-renders — those sites belong to the child patch-branch, which is (re)built by the swap. A non-qualifying nested set is the exception: its content stays parent-owned, so a site in its inactive branch is not found and is reported with `console.error`.

## b-for loops

A `b-for` reaches here over a store's data (`b-for="t in tags.data.list"`), the only declared input that can be a collection, or over a property of an enclosing loop's item. Each rendered item is a patch-branch of its own. The generated module ships a snapshot of the loop as an RNode literal, which holds the iterable and loop names and which an added item is rendered from, like a set's.

### Additional qualification rules

A loop qualifies only when it has a `b-key`, its iterable and key parse, its iterable names a variable, and its body passes the same whole-subtree check as a set's branches: no partial references, slots or asset references. A failure disqualifies the whole loop, silently, and nothing inside it is patched. The compiler requires a `b-key` on every `b-for` in a partial that generates client JS, qualifying or not, so a loop needs no change when more of them qualify.

### Item scope

Items share a parent element and repeat each other's `data-bfid`s and markers, since every item comes from one template. So an item's patch-branch takes the parent as its ref element and adds an **item range**, the nodes from its item marker up to the next item marker or the loop's end marker. Its element and marker lookups stay within the range. A set directly in the item passes the range on to its branches. Anything below an element of the item needs no range, since that element is already unique to the item.

The range is worked out from the item marker on each lookup. The marker moves with the item, so a moved item's patch-branch stays valid.

### Pairing items with the DOM

The server generates the HTML and the data together, so the data at init is what was rendered, and the Nth key belongs to the Nth item marker. Keys are computed only in the browser, so they never appear in the HTML and the server never computes them. Pairing writes nothing. A mismatch (not an array, a bad or repeated key, a count that differs from the markers) is reported, and the loop stays as rendered from then on, since no later data could be trusted to pair with this DOM.

### Updating

Each update evaluates the iterable and keys. Anything wrong with them is reported and the loop skips that update. When the keys and their order are unchanged, each item's patch-branch just updates. Otherwise:

1. New items are rendered, ahead of any change, so a render that throws leaves the DOM as it was.
2. Items whose keys are gone are removed, with all their nodes.
3. A cursor walks the new order, at the position being filled. An item already there stays untouched and the cursor moves past it, a kept item elsewhere has its nodes moved to the cursor, and a new key's fragment is inserted there.
4. Each item's patch-branch updates with its new data and index.

The walk does not find the fewest moves: `[A,B,C,D]` to `[B,C,D,A]` moves B, C and D rather than A. Moves use `moveBefore` where the browser has it, which keeps focus, iframes and animations, and `insertBefore` otherwise.

## Generated module shape

For a partial `my-element` with live vars `title` and `flag`:

```js
import { BackflipShell, BackflipElement } from './runtime/dom-patch/patch.js';   // BackflipElement for base/full
import bfstore_widgets from "/static/stores/widgets.js";                        // each store the patching reads

const bfif_<setId> = { type:'if', branches: [ ... ] };   // one snapshot per if-set and loop, innermost first
const bffor_<loopId> = { type:'for', iterable: { ... }, valName: 'w', nodes: [ ... ] };

export class BackflipMyElement extends BackflipShell {
    static bfAttrs = { "title": 'string', "flag": 'bool' };   // every declared b-attr
    static bfStores = { widgets: bfstore_widgets };       // each store the patching reads
    static bfRoot = {                                     // the root patch-branch
        sites: [
            { bfid: 'bf0', attr: 'title', expr: { fn: function ( title ) { return title; }, vars: ['title'] } },
            { bfid: null, markers: ['bfid:bf1', 'bfid:bf2'], expr: { ... } },   // a print on the element itself
        ],
        sets: [
            { bfid: 'bf3', markers: ['bfid:bf4', 'bfid:bf5'],
                snapshot: bfif_bf4,
                branchMarkers: ['bfid:bf4:0', 'bfid:bf4:1'],
                branches: [ { sites: [ ... ], sets: [ ... ] }, null ] },
        ],
        loops: [                                          // only when there are any
            { bfid: 'bf6', markers: ['bfid:bf7', 'bfid:bf8'],
                itemMarker: 'bfitem:bf7',
                snapshot: bffor_bf7,
                key: { fn: function ( w ) { return w.id; }, vars: ['w'] },
                item: { sites: [ ... ], sets: [ ... ] } },
        ],
    };
}
```

`b-generate="base"` and `"full"` append `BackflipMyElementElement` and, for `"full"`, the `customElements.define` call — see [the custom element class](#the-custom-element-class). Only these two classes are exported; there is no other generated code.

The descriptors (the runtime's `BranchDesc`, `SetDesc`, `LoopDesc` and `SiteDesc`):

- **`bfid`** locates the element a site or set is anchored to: a descendant of the patch-branch's ref element with that `data-bfid`, or the ref element itself when `null`. Instances of a partial share their bfids, so a match inside a nested instance of the same tag (one in slot content) is skipped.
- **An attr site** (`attr`, caller attr, definition-root attr) names the attribute as written, and `bool: true` for a boolean one. Its expression's value is set with `setAttribute(name, String(value))`, or the attribute is removed for `null`, `undefined` and `false`; a boolean one is present (`''`) or removed. Both match the server-rendered HTML, and the omit rule is the renderer's `attrIsRendered`.
- **A print site** names its marker comments. The range between them is replaced with a text node (never markup), so siblings are preserved and the value is never parsed.
- **A set** names its markers, its module-level snapshot, each branch's marker (`branchMarkers`), and one descriptor per branch — `null` for a branch with nothing to patch.
- **A loop** names its markers, its item marker, its module-level snapshot, its key expression, and one descriptor all its items share.
- **Expressions** are the same `rfn` literals the JS generator emits, evaluated by the renderer's own `execFn`. An expression's `vars` are how `execFn` passes its arguments; nothing generated links a var to the sites that use it, since a var name is too coarse once vars hold complex data.

## Patch-branches

A **patch-branch** owns patching for a DOM subtree that is either wholly present or wholly absent. It runs from a root element down to — but not including — each nested **qualifying** `b-if` or `b-for` it meets; every branch of that set that owns patchable content is its own patch-branch, nested in the set's descriptor, and so is every item of that loop.

- **Ownership.** A site belongs to the innermost patch-branch containing it. A set or loop belongs to the parent (which owns its anchor and marker pair), while the content sites of its branches or items belong to their own patch-branches. A non-qualifying nested set is inert client-side, so its content stays owned by the enclosing patch-branch.
- **Ref element.** Each patch-branch patches against one element — the custom element for the root, and the element a set or loop is anchored to for each of its branches or items — so every site it owns resolves to that element or a descendant of it. An item also has an [item range](#item-scope) within that element.
- **Updating.** A patch-branch does not know what changed. `update(data)` evaluates everything it owns: each set works out its winning branch and either swaps it in or updates the live branch's patch-branch, each loop brings its items in line and updates them, then each site compares its value with what it shows.
- **Errors.** An expression that throws is reported with `console.error` and stays local: a site shows an empty value, a set keeps its current branch. Each is evaluated again on the next update.
- **Writes only on change.** Each site remembers the value it shows, in DOM form: an attribute's text or presence, or a print's text. It is read from the DOM the first time the site is patched, so the server render (or, for a swapped-in branch, the client render) is the starting point rather than the data. A recomputed value equal to it writes nothing and does not look up the element; a set likewise re-renders only when its winning branch changes.
- **Snapshots.** Every set and loop — nested included — gets its own module-level `bfif_<setId>` or `bffor_<loopId>` snapshot, which a swap or an added item renders. A snapshot refers to each qualifying set or loop nested in it by that name rather than repeating its content (the `ifRef` and `forRef` options of `nodeToJS`), so the consts are emitted innermost-first. A var-free nested `b-if` has no const and stays inline. Snapshots are taken only after pass 1 has spliced every marker at every depth, so a re-rendered parent branch still carries the anchors its nested patch-branches need.

A missing anchor or marker pair means the rendered DOM diverged from the compiled template; it is reported with `console.error` and that patch is skipped. So is an anchor found twice within one instance (a script's clone, or a copy made by the HTML parser), or a marker repeated among its parent's children: patching one copy would hide the problem. A site or set whose lookup failed keeps its state and is retried on every update. One already patched is looked up only when its value changes, so a duplicate made later goes unreported until then.

## The custom element class

`b-generate="base"` and `"full"` add `export class BackflipMyWidgetElement` below the shell; `"full"` also adds a guarded `customElements.define('my-widget', BackflipMyWidgetElement)`. The element class is the lifecycle half and does nothing else — it constructs the shell and tells it about attribute changes and reconnects. The lifecycle is the same for every partial, so it lives in the runtime's `BackflipElement` (an `HTMLElement` subclass), and the generated class only names its shell:

```js
export class BackflipMyWidgetElement extends BackflipElement {
    static bfShell = BackflipMyWidget;
}
```

`BackflipElement` observes the shell's declared attributes (`bfShell.bfAttrs`) and, on init, constructs the shell with the element. Each rule it is built around comes from the custom elements spec, not from preference:

- **Nothing happens in the constructor.** A custom element constructor may not inspect its attributes or children, which is exactly what the shell does. There is no constructor at all; `bfInit()` runs from `connectedCallback`.
- **`connectedCallback` can run mid-parse**, when the element's children do not exist yet. `bfInit` checks `ownerDocument.readyState === 'loading'` and, in that case, waits for `DOMContentLoaded` instead of patching into a half-built subtree. It is also idempotent, since the element can be moved before the document finishes. Once initialized, a later `connectedCallback` schedules a sync, which catches up on what changed while the element was out and finds nothing for a plain move.
- **`attributeChangedCallback` fires before `connectedCallback`**, once per observed attribute, during upgrade, and it reports nothing for an attribute removed before upgrade. So calls before init are ignored, and constructing the shell runs one update: every site and set is compared against the DOM, which fixes whatever changed since the server render and writes nothing where the DOM already matches. A change with `oldValue === newValue` is skipped, since `setAttribute` fires the callback either way.
- **`observedAttributes` and the lifecycle callbacks are read once**, at `define()` time, off the registered class. A `base` subclass that overrides `observedAttributes` without spreading `super.observedAttributes` silently loses all reactivity, so `bfInit` compares the two and `console.error`s the missing names. A forgotten `super.connectedCallback()` is documented, not detectable.
- **Everything the class owns is `bf`-prefixed** (`bfPatch`, `bfInit`, `bfCheckObserved`, and the static `bfShell`), leaving the plain namespace to a subclass.
- **The define is guarded** with `customElements.get`: a name may be registered once, and an unguarded throw would take the rest of the module with it.

Patching targets server-rendered DOM, so an element created with `document.createElement` has nothing to patch; that is documented as unsupported. No shadow root is ever attached.

## Entry point

Every var reaching codegen must be one of the partial's declared inputs, a `b-attr` or a `b-store`; the generator asserts this before emitting a module, since a name that slipped through would compile into a patch writing `undefined` into the page.

`applyDomPatch(file, opts?)` mutates the CompiledFile in place and returns `{ modules }` — one `{ tagName, js }` per partial in the file that generates client JS. `moduleFileName(tagName)` names its file. It also marks each store a module's patching reads as `shipped` on the partial's root, which tells the renderer to send it to the browser. `opts` is `{ bfidGen?, scriptUrlFor?, assetMap? }`:

- `bfidGen` — deterministic id generator (`makeSequentialBfidGen()`) in tests; production uses the default crypto-random generator. One generator is shared across a file's partials, so ids stay distinct across its modules.
- `scriptUrlFor(tagName)` — public URL of that partial's module. When it returns a URL, the partial's root is stamped with a script the renderer auto-includes: an `'entry'` for `b-generate="full"` (the module registers the element itself), a `'dependency'` otherwise. Partials that produce no module are left untouched. When the option is absent, generation is unchanged and nothing is stamped.
- `assetMap` — `@name` → URL prefix, which turns a store file's `@name/subpath` into the URL a module imports.

## Runtime

Every generated module runs on the same browser runtime, `runtime/dom-patch/patch.ts`: `BackflipShell`, the generic `PatchBranch` that interprets the descriptors, and `BackflipElement`. It imports the JS runtime (`runtime/js/render.ts`) for `render`, `activeBranchIndex`, `forItemCtx` and `execFn`, so a swapped-in branch or added item is rendered, chosen and evaluated exactly as the server does it.

Store files import `BackflipStore` from `runtime/dom-patch/stores.ts`; `BackflipShell` hands the stores a shell declares to patching next to its attributes.

Both import `runtime/dom-patch/flush.ts`, which holds the list of elements to sync and each store's registered elements. A change only adds to the list. A microtask, or `flush()`, then dispatches a `bf-store-flush` event on each element in it. Each shell listens on its own element in the capture phase, so ancestors sync first whatever the list's order, and a patch can only add to the list, so dispatches never nest. On the event a shell compares its attributes and each store's `data` with what it last rendered, and updates its root patch-branch if any differ.

`RUNTIME_FILES` lists these as paths relative to the package's `dist/`. When a build generates any module, the CLI copies each into the dom-patch output dir at that same relative path, so the modules' `./runtime/dom-patch/patch.js` import and patch.js's own imports both resolve. If a `dist` file is missing the build **errors and stops**, since a silent skip would ship a page that 404s on import. The preview server maps `<domPatchOutputDir>/<file>` to the same `dist` file.

## Script auto-include

`scriptUrlFor` stamps each generating partial's root with its module's URL and kind; the JS generator carries the stamp into the emitted root node, and the renderer includes the scripts of the custom elements they actually render. The caller supplies the URLs: the CLI derives them from the asset prefix covering the output dir.

Inclusion follows what rendered server-side, yet reactive `b-if` sets toggle branches client-side and reactive `b-for` loops add items. This stays correct because **a partial reference of any kind disqualifies its whole set or loop** (see [b-if sets](#b-if-sets) and [b-for loops](#b-for-loops)): a branch or item rendered later can never introduce a custom element whose script was not included.
