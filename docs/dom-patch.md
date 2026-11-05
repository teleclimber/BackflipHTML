# Client-side patching (dom-patch)

A [custom element partial](partials.md#custom-element-partials) can stay live in the browser: when one of its declared attributes or [stores](data-stores.md#changing-a-store) changes, the parts of the server-rendered HTML that depend on it are updated in place, without re-rendering the element. Backflip generates the JavaScript that does this from the template itself.

```html
<my-widget b-attr:count b-attr:open.bool b-generate="full">
	<span :data-count="count">{{ count }}</span>
	<p b-if="open">Details…</p>
</my-widget>
```

With a `dom-patch` [output](#build-output) configured, a page that renders `<my-widget count="3">` automatically loads the generated module, and `el.setAttribute('count', '4')` updates both the `data-count` attribute and the printed text on the next microtask. Toggling `open` renders or removes the paragraph.

---

## What updates in the browser

Inside a partial that generates client JS, anything that depends on a `b-attr` or a [store](data-stores.md) updates when it changes.

Changes wait for the next microtask, so several of them become one update showing one snapshot of attributes and stores. Parents update before children. To read the DOM right after a change, call `flush()` from `runtime/dom-patch/flush.js`; during an update it does nothing.

What updates:

- **Dynamic attributes** (`:name` / `b-bind:name`) on elements in the body, and on the partial's own tag. As on the server, `null`, `undefined` and `false` leave the attribute off.
- **Interpolations** (`{{ expr }}`). The value is written as text, never parsed as HTML.
- **Attributes on nested custom elements** (`<child-el :show="show">`). The child sees a normal attribute change, so a child that generates JS patches its own content in turn. This is how a value flows from a parent element down into a child.
- **`b-if` / `b-else-if` / `b-else` sets** — see [Reactive `b-if`](#reactive-b-if).
- **`b-for` loops** — see [Reactive `b-for`](#reactive-b-for).

An expression that uses no variable never changes and is left alone. Every other value in the partial is evaluated on each update, and only what differs from what it last rendered is written to the DOM.

Not patched:

- anything inside a non-reactive `b-for` loop;
- dynamic attributes on nested custom-element calls that carry an asset reference (`:src~`), since the browser has no asset map;
- slot content passed to a nested custom element;
- the partial's own slots, which hold the caller's content;
- the contents of a `b-part` call.

### Reactive `b-if`

A `b-if` set re-renders in the browser when the winning branch changes: the new branch is rendered client-side and swapped into place. Sets may be nested; an inner set re-renders on its own when only its condition changes, and the dynamic parts of a rendered branch keep patching.

A set is reactive when it is:

- not inside a non-reactive `b-for`;
- driven by variables (attributes or stores) in each of its branch conditions (`b-else` excepted);
- free of partial references (`b-part` calls and custom-element calls), slots, and asset references anywhere in its subtree.

Any failure makes the whole set non-reactive, and a disqualifier inside a nested set makes the enclosing set non-reactive too. A non-reactive set still renders correctly on the server — it just stays as rendered.

The rule against partial references is what keeps [script auto-include](#script-auto-include) correct: a branch shown later in the browser can never introduce a custom element whose script the page did not load.

### Reactive `b-for`

A `b-for` updates item by item, matching each item to its DOM by its [`b-key`](directives.md#b-for--loop):

```html
<my-list b-store:todos b-generate="full">
	<ul><li b-for="t in todos.data.list" b-key="t.id" :class="t.done ? 'done' : null">{{ t.title }}</li></ul>
</my-list>
```

- A **new key** is rendered in the browser and inserted at its position.
- A **key that is gone** has its item's DOM removed.
- An item whose **position changed** has its existing DOM moved, never rebuilt. An item already in place is not touched. Where the browser supports `moveBefore`, a moved item also keeps its focus and running animations.
- Every **kept item** updates in place, and only what differs is written.

Because items are matched by key, replacing the whole list with new objects, such as a server response, updates the same way. `b-key="i"` matches items by position, which also works but keeps DOM state, such as an input's value, at the position instead of with the item.

An item can be any shape: one element, several elements, text, or nothing at all. Items can hold `b-if` sets and other loops, and a loop can sit inside a reactive `b-if` branch.

A loop is reactive when it is:

- not inside a non-reactive `b-for`;
- iterating over an expression that names a variable;
- free of partial references (`b-part` calls and custom-element calls), slots, and asset references anywhere in its body, the same rule as for a [reactive `b-if`](#reactive-b-if), since a new item is rendered in the browser.

Any failure makes the whole loop non-reactive, and a disqualifier inside a nested set or loop makes the enclosing set or loop non-reactive too. A non-reactive loop still renders correctly on the server — it just stays as rendered.

Patching pairs items with their DOM from the data, so the rendered list has to match the data the page shipped. In the browser, a reactive loop's iterable must be an **array**, and each key a string or number that is **unique in the list**. When these do not hold, a console error is logged. If that happens as the element initializes, the loop stays as rendered from then on. On a later update, the loop skips that update and tries again on the next.

---

## Scripts and patched DOM

Patching owns the DOM it manages. The server generates a page's HTML and data together, so they match when the page loads, and patching depends on that match lasting. Scripts must not change that DOM directly.

Patching does not try to detect or repair direct changes. Some cause a console error, and others leave the page wrong with no warning.

---

## `b-generate`

`b-generate` on a custom element partial's definition tag says how much JavaScript Backflip generates:

| Value | Generated | You write |
|---|---|---|
| `full` | the patch class, an `HTMLElement` subclass, and `customElements.define()` | nothing |
| `base` | the patch class and an `HTMLElement` subclass to extend | a subclass and its `customElements.define()` |
| `render` | the patch class alone | the whole web component |

Each partial that generates JS gets **its own module**, named after its tag (`my-widget.js`) at the root of the [dom-patch output dir](#build-output). It exports:

- `BackflipMyWidget` — the patch class. Constructed with the element, it reads the declared attributes and patches the rendered DOM. Always exported. In `render` mode your component calls its `update()` when an attribute changes or the element is connected again; the DOM updates on the next microtask.
- `BackflipMyWidgetElement` — the `HTMLElement` subclass driving it, for `base` and `full`.

With `b-script` present and no `b-generate`, the mode is `base`. Nothing is generated when a partial has neither.

### Extending the generated class (`base`)

```js
import { BackflipMyWidgetElement } from '/bfdom/my-widget.js';

class MyWidget extends BackflipMyWidgetElement {
	static observedAttributes = [...super.observedAttributes, 'open'];

	connectedCallback() {
		super.connectedCallback();
		this.addEventListener('click', () => this.toggleAttribute('open'));
	}
}
customElements.define('my-widget', MyWidget);
```

`connectedCallback` can run more than once, because moving an element in the page disconnects and reconnects it. Attach listeners on the element itself in the constructor, where they are added once. Anything `connectedCallback` sets up outside the element, such as a listener on `document`, must be undone in `disconnectedCallback`. (OK but the solution is not the constructor)

Two rules the browser enforces silently:

- `observedAttributes` and the lifecycle callbacks are read **once**, when `customElements.define()` runs, off the class you register. A subclass that declares `static observedAttributes` without spreading `super.observedAttributes`, or defines `connectedCallback` / `attributeChangedCallback` without calling `super`, stops the patching with no error. The generated class reports a missing attribute to the console when it initializes.
- The generated class puts only `bf`-prefixed members on the element (`bfPatch`, `bfInit`, …) and on the class (`bfShell`), so the rest of the namespace is yours. `bfPatch` is the patch class instance, available once the element is connected and the document has parsed.

Subclassing is not a way to extend a `full` partial: `customElements.define()` refuses a constructor that is already registered, and a subclass could only be registered under a different tag name — one the server never renders. Use `base` when you need your own behavior.

### Client script (`b-script`)

For `base` and `render`, the browser needs your module — the one that subclasses or drives the generated class. Point the renderer at it with `b-script` on the definition tag, using an [asset path](assets.md):

```html
<my-widget b-attr:count b-script="@scripts/my-widget.js">
	<span :data-count="count">{{ count }}</span>
</my-widget>
```

Your module is the page's **entry** for this element and the generated module is its **dependency**; see [Script auto-include](#script-auto-include). With `b-generate="full"` there is no author module: the generated one is the entry.

### Rules and errors

- `b-generate` and `b-script` are allowed only on a custom element partial **definition** tag. `b-generate` takes one of the three values above and cannot be bare. `b-script` is an asset path (`@name/subpath`) to an existing file in a configured asset directory, at most one per definition.
- **Data comes in through `b-attr` and `b-store`.** The browser patches from the values it can read: the element's attributes and the page's [stores](data-stores.md). Anything else could go stale the moment an attribute changes. A variable the partial body uses must be declared with `b-attr:NAME` (a string or boolean) or `b-store:NAME` (any JSON), and `b-data:NAME` on a call to such a partial is an error.
- A store such a partial declares must be served: its store file has to sit inside an asset directory, since the generated module imports it.
- Every `b-for` in such a partial must have a [`b-key`](directives.md#b-for--loop).
- A partial that generates JS must have a project-unique tag name, since its module and its registration are named after the tag.

The build warns, against the definition tag, when:

- the partial declares `b-attr` but has neither `b-generate` nor `b-script` — nothing is generated and the attributes patch nothing;
- it is `base` or `render` with no `b-script` — nothing loads the generated module;
- it is `full` *and* has a `b-script` — the element is registered twice, and the second `define()` throws.

---

## Limits

- Patching targets **server-rendered** DOM. An element created in JavaScript (`document.createElement('my-widget')`) has no content to patch, and is not supported.
- No shadow root is attached: patching works against the light-DOM children the server rendered.
- An expression that throws in the browser, such as a [lookup that misses](data-stores.md#lookups-that-miss), is logged and affects only that value.
- `<script>` tags inside a reactive `b-if` branch or `b-for` item do not run when it is rendered in the browser.
- A `<tr b-for>` directly under a `<table>` is not updated, because the HTML parser adds a `<tbody>` that splits the loop's marker comments. Write the `<tbody>` in the template.
- Moving an item toward the end of a list also moves the items it passed, which then lose focus in browsers without `moveBefore`.
- Inside a reactive area, a non-reactive nested `b-if` keeps the branch the server rendered; dynamic values in its other branches cannot be found, and each update logs a console error for them.
- When the rendered DOM no longer matches the template (for example, other script removed a patched element), the affected patch is skipped with a console error.
- When a patched element or its marker comments appear twice (other script cloned them, or invalid HTML such as a `<div>` inside a `<p>` made the parser copy the element), neither copy is updated and a console error is logged.

---

## Build output

Enable generation with a `dom-patch` [output entry](configuration.md) (or `--lang dom-patch` on the [CLI](cli.md)):

```json
{
  "root": "templates",
  "output": [
    { "lang": "js", "path": "out/js" },
    { "lang": "dom-patch", "path": "static/bfdom" }
  ],
  "assets": [
    { "name": "bfdom", "path": "static/bfdom", "prefix": "/bfdom/" }
  ]
}
```

- Each module is written flat at the output root, named after its partial's tag, wherever the defining template sits. Its URL stays stable when the template moves, which is what a hand-written `import` depends on.
- The browser runtime the modules import is copied into the output dir under `runtime/`, including `runtime/dom-patch/stores.js`, which store files import, and `runtime/dom-patch/flush.js`, which exports `flush()`.
- A module imports the store files its patching reads, by their served URLs.
- The dom-patch pass adds `data-bfid` attributes and marker comments to the server-rendered HTML of generating partials, so the browser can find what to patch. These markers come from the same build as the modules: always deploy the server output and the dom-patch output together.

---

## Script auto-include

The [JS](runtime-js.md) and [PHP](runtime-php.md) renderers include the scripts and stores of the custom elements a page actually renders; there is no manual `<script>` step.

- An **entry** is injected as `<script src="…" type="module"></script>`: the generated module for `full`, your `b-script` module otherwise.
- A **dependency** — the generated module for `base` and `render` — is injected as `<link rel="modulepreload" href="…">`, so the browser fetches it in parallel with the entry that imports it.
- A store the generated code reads is **shipped**: its data as a JSON tag, and its store file as a dependency. See [Data stores → Shipping](data-stores.md#shipping-data-to-the-browser).
- The block holds the store tags, then the dependencies, then the entries. Store tags are deduplicated by store name, scripts by URL, each in first-encounter order. The block goes immediately before the first `</body>` (case-insensitive), or at the end of the output when there is none. Streaming and non-streaming renders produce identical output.
- Only rendered elements count: a custom element in an untaken `b-if` branch, or in a `b-for` over an empty list, contributes nothing. A page with none gets no block.
- Only a page render (`renderRoot` / `streamRenderRoot` and their PHP equivalents) injects; a nested partial never emits its own block.

### Module URLs

For auto-include to work, the dom-patch output dir must be covered by an [asset](assets.md) entry — an asset `path` that equals or contains it. A module's URL is that asset's `prefix` followed by the file's path relative to the asset dir; when several asset dirs cover it, the most specific wins. Making the output dir an asset dir of its own, as above, is the simplest setup.

If no asset covers it, the build warns and no scripts are included:

```
warning: dom-patch output "<path>" is not covered by an asset prefix; generated scripts will not be auto-included. Add an asset entry whose directory contains this output dir.
```

---

## Preview

The [preview](preview.md#dom-patch-reactivity) regenerates the dom-patch modules on every render and serves those in place of the files on disk, so the patching JS always matches the previewed HTML. No build is needed to preview a reactive partial.
