# Client-side patching (dom-patch)

A [custom element partial](partials.md#custom-element-partials) can stay live in the browser: when one of its declared attributes changes, the parts of the server-rendered HTML that depend on it are updated in place, without re-rendering the element. Backflip generates the JavaScript that does this from the template itself.

```html
<my-widget b-attr:count b-attr:open.bool b-generate="full">
	<span :data-count="count">{{ count }}</span>
	<p b-if="open">Details…</p>
</my-widget>
```

With a `dom-patch` [output](#build-output) configured, a page that renders `<my-widget count="3">` automatically loads the generated module, and `el.setAttribute('count', '4')` updates both the `data-count` attribute and the printed text. Toggling `open` renders or removes the paragraph.

---

## What updates in the browser

Inside a partial that generates client JS, anything that depends on a `b-attr` or a [store](data-stores.md) updates when it changes. Only attributes change in the browser today, so in practice a value updates when one of its attributes does, reading the store's current data: `{{ widgets.data[widget_id].name }}` updates when `widget_id` changes. A value that depends on stores alone is checked against the server's HTML when the element starts up, and left alone after.

What updates:

- **Dynamic attributes** (`:name` / `b-bind:name`) on elements in the body, and on the partial's own tag.
- **Interpolations** (`{{ expr }}`). The value is written as text, never parsed as HTML.
- **Attributes on nested custom elements** (`<child-el :show="show">`). The child sees a normal attribute change, so a child that generates JS patches its own content in turn. This is how a value flows from a parent element down into a child.
- **`b-if` / `b-else-if` / `b-else` sets** — see [Reactive `b-if`](#reactive-b-if).

An expression that uses no variable never changes and is left alone. Only what actually changes is written to the DOM.

Not patched:

- anything inside a `b-for` loop;
- dynamic attributes on nested custom-element calls that carry an asset reference (`:src~`), since the browser has no asset map;
- slot content passed to a nested custom element;
- the partial's own slots, which hold the caller's content;
- the contents of a `b-part` call.

### Reactive `b-if`

A `b-if` set re-renders in the browser when the winning branch changes: the new branch is rendered client-side and swapped into place. Sets may be nested; an inner set re-renders on its own when only its condition changes, and the dynamic parts of a rendered branch keep patching.

A set is reactive when it is:

- not inside a `b-for`;
- driven by variables (attributes or stores) in each of its branch conditions (`b-else` excepted);
- free of partial references (`b-part` calls and custom-element calls), slots, and asset references anywhere in its subtree.

Any failure makes the whole set non-reactive, and a disqualifier inside a nested set makes the enclosing set non-reactive too. A non-reactive set still renders correctly on the server — it just stays as rendered. A `b-for` inside a reactive set is fine: it is rendered as part of its branch.

The rule against partial references is what keeps [script auto-include](#script-auto-include) correct: a branch shown later in the browser can never introduce a custom element whose script the page did not load.

---

## `b-generate`

`b-generate` on a custom element partial's definition tag says how much JavaScript Backflip generates:

| Value | Generated | You write |
|---|---|---|
| `full` | the patch class, an `HTMLElement` subclass, and `customElements.define()` | nothing |
| `base` | the patch class and an `HTMLElement` subclass to extend | a subclass and its `customElements.define()` |
| `render` | the patch class alone | the whole web component |

Each partial that generates JS gets **its own module**, named after its tag (`my-widget.js`) at the root of the [dom-patch output dir](#build-output). It exports:

- `BackflipMyWidget` — the patch class. Constructed with the element, it reads the declared attributes and patches the rendered DOM. Always exported.
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
- A partial that generates JS must have a project-unique tag name, since its module and its registration are named after the tag.

The build warns, against the definition tag, when:

- the partial declares `b-attr` but has neither `b-generate` nor `b-script` — nothing is generated and the attributes patch nothing;
- it is `base` or `render` with no `b-script` — nothing loads the generated module;
- it is `full` *and* has a `b-script` — the element is registered twice, and the second `define()` throws.

---

## Limits

- Patching targets **server-rendered** DOM. An element created in JavaScript (`document.createElement('my-widget')`) has no content to patch, and is not supported.
- No shadow root is attached: patching works against the light-DOM children the server rendered.
- `<script>` tags inside a reactive `b-if` branch do not run when the branch is rendered in the browser.
- Inside a reactive area, a non-reactive nested `b-if` keeps the branch the server rendered; dynamic values in its other branches cannot be found, and each update logs a console error for them.
- When the rendered DOM no longer matches the template (for example, other script removed a patched element), the affected patch is skipped with a console error.

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
- The browser runtime the modules import is copied into the output dir under `runtime/`, including `runtime/dom-patch/stores.js`, which store files import.
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
