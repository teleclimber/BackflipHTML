# Data stores

A store is a named piece of JSON data — nested objects, collections — that your server code hands to the page renderer. A partial that declares the store reads its data. Stores are how structured data reaches a [client-side patching](dom-patch.md) partial, which otherwise takes only string and boolean `b-attr`s.

In this version store data never changes during the life of a page.

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
- The browser loads the file as written. It imports `stores.js` from the [runtime the build copies](dom-patch.md#build-output) into the dom-patch output directory; a relative import works both in the build and in the [preview](preview.md).

A subclass adds methods for your own browser code. They cannot be called from templates, and may not redeclare `data`:

```js
class Widgets extends BackflipStore {
    ownedBy(owner) { return Object.values(this.data).filter((w) => w.owner === owner); }
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

The page renderers take the store data by name, after `slots`: `renderRoot(n, ctx, slots, stores)` in [JS](runtime-js.md#stores), `backflip_renderRoot($node, $ctx, $slots, $stores)` in [PHP](runtime-php.md#stores), and the same for the streaming renderers. JS `render(...)` also takes `stores`, but never ships them.

- Every rendered partial that declares a store gets it, whether or not it generates client JS. The server never runs the store file.
- The root partial gets `ctx` plus its own declared stores.
- A rendered partial that declares a store you did not pass is a render error, and so is a `ctx` key that is also a store the root partial declares.

---

## Shipping data to the browser

A page render ships a store when the generated code of a [client-side patching](dom-patch.md) partial it actually renders reads it. Like [script auto-include](dom-patch.md#script-auto-include), a partial in an untaken `b-if` branch or an empty `b-for` ships nothing, and a store read only on the server, or only in parts of a partial that are not patched (inside a `b-for`), is not shipped.

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

- `data` is parsed from the store's tag on first access, and every read returns the same object. It is deeply frozen: a write throws.
- On a page that did not ship the store, `data` is `undefined`.
- Read `data` from module code: module scripts run once the document is parsed, and the store tags come before the scripts.

In a patching partial, a store is a variable like a `b-attr`. A value that uses both updates when its attribute changes, reading the store's data: `{{ widgets.data[widget_id].name }}` updates when `widget_id` does. A store can drive a [reactive `b-if`](dom-patch.md#reactive-b-if).

---

## Lookups that miss

A lookup that finds nothing throws, as any expression error does: on the server it fails the render, in the browser it stops that update. The expression language has no `?.` or `&&`, so guard a lookup with a ternary:

```html
<h3>{{ widgets.data[widget_id] ? widgets.data[widget_id].name : '' }}</h3>
```

Since templates cannot call store methods, shape the data on the server so it can be indexed: a map keyed by id rather than an array.

---

## Errors

Compile errors:

- a store file whose default export is not `new BackflipStore('name')` or `new C('name')` (with `C` a class in the file extending `BackflipStore`), or a store class redeclaring `data`;
- a store name that is not a valid identifier (uppercase letters are a warning), or two store files declaring the same name;
- `b-store` anywhere but a partial definition tag, with a value, or naming no declared store;
- `b-store:NAME` next to `b-attr:NAME` on one tag, or `b-data:NAME` at a call to a partial that declares `b-store:NAME`;
- a partial that generates client JS declaring a store that is not served;
- a store used in a partial that does not declare it (the usual [unbound variable](partials.md#partial-scope) errors).

Render errors: a missing store, a root `ctx` key that collides with a store, and a shipped store whose data cannot be serialized to JSON.
