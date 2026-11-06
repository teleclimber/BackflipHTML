# Data stores

A store is a named piece of JSON data — nested objects, collections — that your server code hands to the page renderer. A partial that declares the store reads its data. Stores are how structured data reaches a [client-side patching](dom-patch.md) partial, which otherwise takes only string and boolean `b-attr`s.

Browser code can [change a store](#changing-a-store), and the patching partials that read it update.

```html
<my-widget b-store:widgets b-attr:widget_id b-generate="full">
    <h3>{{ widgets.data[widget_id].name }}</h3>
</my-widget>
```

```ts
renderRoot(page, ctx, undefined, { widgets: { "42": { name: "Gizmo", owner: "ann" } } });
```

---

## Store files

Every store is declared by a store file: a JS module, in a directory listed under [`stores`](configuration.md#stores) in `backflip.json`, whose default export is the store.

```js
// static/scripts/stores/widgets.js
import { BackflipStore } from '../../bfdom/runtime/dom-patch/stores.js';

export default new BackflipStore('widgets');
```

- The store's **name** is the constructor's string argument, not the file name. It must be a valid identifier (no hyphens), since templates use it as a variable, and should be lowercase, since HTML lowercases `b-store:NAME`.
- The compiler reads the file without running it. The default export must be `new BackflipStore('name')`, or `new C('name')` where `C` is a class declared in the file that extends `BackflipStore`.
- The browser loads the file as written. It imports `stores.js` from the [runtime the build copies](dom-patch.md#build-output) into the dom-patch output directory; a relative import works both in the build and in the [preview](preview.md). All of a page's code must load the runtime from that one URL, since a second copy would keep its own record of what changed.

A subclass adds methods for your own browser code. They cannot be called from templates, and may not redeclare `data`, `set` or `setAt`:

```js
class Widgets extends BackflipStore {
    ownedBy(owner) { return Object.values(this.data).filter((w) => w.owner === owner); }
    rename(id, name) { this.setAt([id, 'name'], name); }
}

export default new Widgets('widgets');
```

A store directory inside an [asset](assets.md) directory is **served**: the browser can load its store files. Only served stores can be read by partials that generate client JS. Stores in other directories are for server-rendered partials only.

---

## Declaring use: `b-store:NAME`

`b-store:NAME` on a partial definition tag — a `b-name` partial or a custom element partial — binds `NAME` to the store in that partial. Its data is `NAME.data`. Several are allowed on one tag.

Stores follow the [partial scope](partials.md#partial-scope) rules:

- A store is visible only in the partial that declares it. A partial it calls does not inherit it; each partial that reads a store declares it itself.
- Nothing is written at the call site. The partial gets its stores from the renderer.
- Slot content is evaluated in the caller's context, so it sees the **caller's** stores.

```html
<b-unwrap b-name="dashboard" b-store:widgets>
    <my-card>
        <p>{{ widgets.data["42"].owner }}</p>
    </my-card>
</b-unwrap>
```

---

## Passing stores to the renderer

The page renderers take the store data by name, after `slots`: `renderRoot(n, ctx, slots, stores)` (see [JS runtime](runtime-js.md#stores)), and the same for `streamRenderRoot`. `render(...)` also takes `stores`, but never ships them.

- Every rendered partial that declares a store gets it, whether or not it generates client JS. The server never runs the store file.
- The root partial gets `ctx` plus its own declared stores.
- A rendered partial that declares a store you did not pass is a render error, and so is a `ctx` key that is also a store the root partial declares.

---

## Shipping data to the browser

A page render ships a store when the generated code of a [client-side patching](dom-patch.md) partial it actually renders reads it. Like [script auto-include](dom-patch.md#script-auto-include), a partial in an untaken `b-if` branch or an empty `b-for` ships nothing, and a store read only on the server, or only in parts of a partial that are not patched (inside a non-reactive `b-for`), is not shipped.

A shipped store becomes a JSON tag in the auto-include block, ahead of the scripts, with its store file as a module dependency:

```html
<script type="application/json" data-bf-store="widgets">{"42":{"name":"Gizmo","owner":"ann"}}</script>
<link rel="modulepreload" href="/static/scripts/stores/widgets.js">
```

The tag format is not an API: read data through the store.

> **Everything in a shipped store is sent to the client, in full.** Pass only data that is fine to be public, shaped for the page.

---

## In the browser

The store file's default export is the store. Generated modules import it, and so can your own code:

```js
import widgets from '/static/scripts/stores/widgets.js';

widgets.data['42'].name;
```

- `data` is parsed from the store's tag on first access, and every read returns the same object until the store changes. It is deeply frozen: a write throws.
- On a page that did not ship the store, `data` is `undefined`.
- Read `data` from module code: module scripts run once the document is parsed, and the store tags come before the scripts.

In a patching partial, a store is a variable like a `b-attr`: `{{ widgets.data[widget_id].name }}` updates when `widget_id` or the store changes. A store can drive a [reactive `b-if`](dom-patch.md#reactive-b-if) or a [reactive `b-for`](dom-patch.md#reactive-b-for).

---

## Changing a store

Store methods and your own code change a store with `set` and `setAt`:

```js
widgets.rename('42', 'Sprocket');                 // a method calling setAt
widgets.set(await response.json());               // apply a server response
```

- `store.set(data)` replaces the data. The value must be JSON-like (strings, finite numbers, booleans, `null`, arrays and plain objects, with no cycles; a property holding `undefined` is not allowed), and it is deeply frozen. Anything else throws. Setting the current `data` does nothing.
- `store.setAt(path, value)` sets the value at `path`, an array of keys, copying each object or array along it. The last key may be new. A missing earlier key throws, as does an array index that is not a non-negative integer.

`data` is the new value right away; the DOM follows on the next microtask, after any other changes made in the meantime, so a partial never shows a mix of old and new. Call `flush()` when code must read the DOM right after a change:

```js
import { flush } from '/bfdom/runtime/dom-patch/flush.js';

widgets.rename('42', 'Sprocket');
flush();
```

`set` and `setAt` throw on a page that did not ship the store, which includes a store read only in parts of a partial that are not patched. They also throw during a flush, including from code a patch runs, such as an `attributeChangedCallback`; make the change from a microtask instead.

A change updates only what [client-side patching](dom-patch.md#what-updates-in-the-browser) patches. Everything else keeps showing the store as it was rendered: `b-name` partials, non-reactive `b-for` loops and `b-if` sets, slot content and `b-part` call contents. The compiler does not warn about these.

---

## Lookups that miss

A lookup that finds nothing throws, as any expression error does. On the server it fails the render. In the browser it is logged with `console.error` and affects only that value: a printed value or attribute goes empty and a boolean attribute is removed, a `b-if` keeps its current branch, and each is evaluated again on the partial's next update. The expression language has no `?.`, so guard a lookup with a ternary, or with `&&` in a condition:

```html
<h3>{{ widgets.data[widget_id] ? widgets.data[widget_id].name : '' }}</h3>
<p b-if="widgets.data[widget_id] && widgets.data[widget_id].archived">Archived</p>
```

Since templates cannot call store methods, shape the data on the server so it can be indexed: a map keyed by id rather than an array.

---

## Errors

Compile errors:

- a store file whose default export is not `new BackflipStore('name')` or `new C('name')` (with `C` a class in the file extending `BackflipStore`), or a store class redeclaring `data`, `set` or `setAt`;
- a store name that is not a valid identifier (uppercase letters are a warning), or two store files declaring the same name;
- `b-store` anywhere but a partial definition tag, with a value, or naming no declared store;
- `b-store:NAME` next to `b-attr:NAME` on one tag, or `b-data:NAME` at a call to a partial that declares `b-store:NAME`;
- a partial that generates client JS declaring a store that is not served;
- a store used in a partial that does not declare it (the usual [unbound variable](partials.md#partial-scope) errors).

Render errors: a missing store, a root `ctx` key that collides with a store, and a shipped store whose data cannot be serialized to JSON.
