# DOM-patch generator

Produces a JavaScript file with one class per custom-element partial that has at least one reactive attribute. The class lets browser-side code update specific attributes of specific rendered elements when one of the custom element's own attributes changes — without re-rendering the whole subtree.

## How it fits

Unlike the [`js/`](../js/README.md) and [`php/`](../php/README.md) generators (which only read the AST), dom-patch **mutates** the un-flattened AST on its way through. For every qualifying attribute site it appends a `data-bfid="..."` static attribute to the owning element so the runtime class can find it via `querySelector`. The mutated AST then flows to the other generators, so the server-rendered HTML carries the same `data-bfid` markers.

Because of this, the CLI calls `applyDomPatch()` on each `CompiledFile` **before** running flatten + js/php codegen.

## What qualifies (v1)

Only attribute sites are emitted. A site qualifies when **all** of these hold:

- The owning partial is a **custom-element partial** (`b-attr:` declarations are the source of "live" variables).
- The attribute is a `b-bind:`/`:` dynamic attribute (a `Parsed` expression in `AttrPart.dynamic.expr`).
- Every variable in `parsed.vars` is one of the partial's live vars. Mixed live + non-live expressions are skipped entirely.
- The element is **not** inside a `b-for` loop. (v1 limitation — see below.)

Sites that don't qualify are silently ignored: prints, `b-if` conditions, `b-for` iterables, `b-data:` bindings, caller-side attr expressions on nested custom-element calls. Slot contents are not entered (they live in the caller's scope).

If a partial produces zero classes, it contributes nothing to the file. If a file produces zero classes, no file is emitted.

## v1 limitation: no for-loop attrs

Attributes whose ancestor chain contains a `ForTNode` are skipped. The bfid mechanism relies on `querySelector`, which returns only the first match — so an attribute on a `b-for`'d element would only update one of N rendered copies. This is documented rather than worked around; an explicit error is not raised (it's a silent skip, as for any non-qualifying site).

## Generated class shape

For a partial `my-element` with live vars `title` and `flag`:

```js
class BackflipMyElement {
    constructor(ce) { this.ce = ce; }
    sel_<bfid>() { return this.ce.querySelector('[data-bfid="<bfid>"]'); }
    bc_<bfid>_<attr>(data) { ... }       // expression body, destructured from data
    mutate_<varName>(data) { ... }       // calls sel + bc + setAttribute / removeAttribute
    collectData() { return { title: ..., flag: ... }; }
    update(varName) { switch(varName) { case '<v>': this.mutate_<v>(this.collectData()); ... } }
}
```

- `collectData()` returns every declared `b-attr` (string → `getAttribute(name) ?? ''`; bool → `hasAttribute(name)`).
- `update(varName)` only switches over live vars **that have at least one mutate-able site**. Unused live vars still appear in `collectData`, just not in `update`.
- Boolean dynamic attributes use `setAttribute(name, '')` / `removeAttribute(name)` to match the server-rendered HTML.

## Identifier sanitization

The bfid and attribute function name must be valid JS identifiers, but the runtime DOM call must use the original (stripped) attribute name. So `data-foo` becomes `bc_<bfid>_data_foo` in the function name but stays `'data-foo'` in `setAttribute`.

## Entry point

`applyDomPatch(file, bfidGen?)` mutates the CompiledFile in place and returns `{ js: string | null }`. Tests pass a deterministic `makeSequentialBfidGen()`; production code uses the default crypto-random generator.
