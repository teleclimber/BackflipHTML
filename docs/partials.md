# Partials

Partials are reusable HTML fragments. You define them in `.html` files, then include them from other templates. The compiler resolves partial references and produces one JavaScript module per HTML file, so you only load what you need at render time.

---

## Template files

Every top-level element in a template file must have a `b-name` attribute. The compiler will report an error for any top-level element that lacks `b-name`.

You can have `<html>` tags, but do not include the `<DOCTYPE !html>`.

You point the compiler at a directory and it processes all `.html` files within it.

---

## Defining a partial

Add a `b-name` attribute to a top-level element. The element and its contents become the partial.

```html
<article b-name="post">
    <h1>Hello</h1>
    <p>Some text.</p>
</article>
```

If you want the partial to render only its inner content (without the container element), use `<b-unwrap>`:

```html
<b-unwrap b-name="notice">
    Just this text, no wrapper element.
</b-unwrap>
```

`b-name` must be on a top-level element (a direct child of the implied document body). Using it on a nested element is a compilation error.

---

## Including a partial

Use the `b-part` attribute to include a partial. The value is `#partial-name` for a same-file reference.

```html
<article b-name="post">
    <p>Some text...</p>
    <div b-part="#notice"></div>
</article>

<p b-name="notice">
    Notice!
</p>
```

The `<div>` wrapper is kept in the output. To include without a wrapper, use `<b-unwrap>`:

```html
<b-unwrap b-part="#notice"></b-unwrap>
```

If the referenced partial does not exist, that is a compilation error.

### Dynamic attributes on the b-part wrapper

Attributes on the carrying tag (including `:bind`/`b-bind:` dynamic attrs and `~` asset attrs) are rendered on the wrapping element of the partial call.

```html
<div b-part="#notice" :class="alertCls"></div>
```

Renders the `<div>` wrapper with `class="..."` evaluated from `alertCls` at render time. Falsy values (null, undefined, false) omit the attribute, matching the standard `b-bind` rule. Use `<b-unwrap b-part="#notice">` if you do not want a wrapping element.

---

## Including partials from other files

To make a partial available outside its own file, add `b-export`:

```html
<!-- graphics/charts.html -->
<svg b-name="pie-chart" b-export>
    ...
</svg>
```

Then reference it from another file using a path relative to the template root, in the form `path/to/file.html#partial-name`:

```html
<!-- blog/general.html -->
<article b-name="post">
    <div b-part="graphics/charts.html#pie-chart"></div>
</article>
```

Referencing a partial in another file that does not have `b-export` is a compilation error.

Each HTML file compiles to one JavaScript module. Cross-file `b-part` references become static `import` statements at the top of the generated module, so the JavaScript module system handles loading — the runtime never touches file paths.

---

## Slots

A partial can declare a slot — a place where the caller can inject content.

**Default slot:**

```html
<!-- caller -->
<article b-name="post">
    <div b-part="#notice">This appears in the slot.</div>
</article>

<!-- partial definition -->
<p b-name="notice">
    Notice! <b-unwrap b-slot />
</p>
```

Children of the `b-part` element become the default slot content. The `<b-unwrap b-slot />` marker in the partial is replaced with that content at render time.

**Named slots:**

```html
<!-- caller -->
<article b-name="post">
    <div b-part="#notice">
        <b-unwrap b-in="message">This appears in the named slot.</b-unwrap>
    </div>
</article>

<!-- partial definition -->
<p b-name="notice">
    Notice! <b-unwrap b-slot="message" />
</p>
```

Use `b-in="name"` inside the `b-part` element to direct content to a named slot. Use `b-slot="name"` in the partial definition to declare where that slot renders.

**Slot scoping:** Slot content is evaluated in the *caller's* data context, not the partial's. Expressions like `{{ user.name }}` inside slot content refer to the caller's variables.

If a slot is declared but no content is provided, the slot renders empty. If a slot does not exist in the partial, that is a compilation error.

**Wrapping element:** `b-slot` on a regular tag (anything other than `<b-unwrap>`) keeps that tag in the output and renders the slot content inside it. Use `<b-unwrap b-slot />` to inject only the slot content with no wrapper.

```html
<!-- partial definition -->
<div b-name="card">
    <span b-slot class="body"></span>
</div>
```

Called with slot content `Hi`, this renders `<div><span class="body">Hi</span></div>`.

---

## Passing data to partials

Data is passed explicitly using `b-data:<varname>="expression"`. The expression is evaluated in the caller's context.

```html
<!-- caller -->
<article b-name="post">
    <b-unwrap b-part="#notice" b-data:mood="user.mood"></b-unwrap>
</article>

<!-- partial definition -->
<p b-name="notice">
    My mood is {{ mood }}.
</p>
```

Multiple variables can be passed on the same element:

```html
<div b-part="#card" b-data:title="item.title" b-data:count="item.count"></div>
```

Data bindings are scoped to the partial — they are not visible outside it, and they do not override the caller's context for slot content.

Each `b-data:NAME` must correspond to a variable used inside the target partial. Passing `b-data:NAME` for a name the partial doesn't use is a compilation error (it usually means a typo or a stale binding).

---

## Compilation errors

The compiler reports errors for:

- A top-level element without `b-name` (every top-level element must be a named partial)
- `b-name` on a non-top-level element
- A `b-part` reference that cannot be resolved (partial not found)
- A cross-file `b-part` reference to a partial that exists but lacks `b-export`
- A named slot reference (`b-in="name"`) where the partial has no matching `b-slot="name"`
- Default slot content provided to a partial that declares no default slot
- Circular cross-file dependencies (A includes B which includes A)
- `b-if`, `b-for`, `b-else`, or `b-else-if` on a partial *definition* (these are call-site directives only)
- `b-attr` outside a custom element partial definition, with a value, with an unknown modifier, or with a conflicting plain attribute on the same tag (see [Declared attributes](#declared-attributes-b-attr))
- A required `b-attr` not provided at the call site, or `b-data:NAME` colliding with a declared `b-attr:NAME`
- `b-data:NAME` at a call site where `NAME` does not appear in the target partial's data shape (i.e. the partial does not use a variable of that name and does not declare a `b-attr:NAME`). This catches typos and stale bindings that would otherwise be silently discarded.

---

## Custom element partials

A hyphenated tag (an HTML *custom element* like `<my-card>`) at the top level of a file defines a partial whose name is the tag itself:

```html
<my-notice class="notice">
    Notice!
</my-notice>
```

Calling it from another partial is just writing the tag again — no `b-part`, no `#name`:

```html
<article b-name="post">
    <p>Some text...</p>
    <my-notice></my-notice>
</article>
```

The result is **a single rendered element**, with attributes from the call site and the definition merged together:

```html
<article>
    <p>Some text...</p>
    <my-notice class="notice">
        Notice!
    </my-notice>
</article>
```

This differs from `b-name`/`b-part` partials, which always emit both the wrapping caller element *and* the partial's own wrapping element.

### Rules

- A custom element tag must follow the [HTML custom-element naming rule](https://html.spec.whatwg.org/multipage/custom-elements.html#valid-custom-element-name): a lowercase letter start, at least one hyphen, no uppercase letters. `b-*` directive tags (e.g. `<b-unwrap>`) are not custom elements.
- A hyphenated tag is treated as a partial definition only when it appears at the **top level** of a template file. Nested hyphenated tags are call sites.
- A custom element partial must have a closing tag, both at the definition site and at the call site. Self-closing custom elements (`<my-card />`) are not valid HTML for non-void elements.
- A definition cannot have `b-name`, `b-if`, `b-for`, `b-else`, or `b-else-if`.
- Once a custom element partial is exported with `b-export`, no other definition of the same name (exported or not) may exist anywhere in the project. Two non-exported definitions of the same name in different files are allowed.
- A custom element partial and a `b-name` partial cannot share the same name in the same file.
- You cannot mix the two reference styles: `b-part="my-notice"` does **not** call the custom element `<my-notice>`, and `<part-name>` does **not** call the `b-name` partial `part-name`.
- Calls to unknown hyphenated tags (no matching definition anywhere) emit a **warning** and fall through as raw HTML — useful for browser-native custom elements that the templating system shouldn't expand.

### Cross-file use

Add `b-export` to a custom element definition to make it callable from any file in the project. Cross-file calls don't need a path — just write the tag:

```html
<!-- components.html -->
<my-card class="card" b-export>
    <h2>{{ title }}</h2>
    <div class="body"><b-unwrap b-slot /></div>
</my-card>

<!-- page.html -->
<article b-name="post">
    <my-card b-data:title="post.heading">
        <p>{{ post.body }}</p>
    </my-card>
</article>
```

### Slots, bindings, and attribute interpolation

Slots (`b-slot`/`b-in`), data bindings (`b-data:*`), and attribute interpolation (`:attr`, `b-bind:attr`) all work the same as for `b-name` partials:

- Slot content is evaluated in the **caller's** context.
- The partial body and definition-side attributes are evaluated in the **child** context — that is, the caller's context with `b-data:*` bindings overlaid.
- Caller-side attributes on the call tag are evaluated in the caller's context.

This means you can mix dynamic attrs from both sides:

```html
<my-notice :data-id="ident"></my-notice>
```

renders as `<my-notice data-id="42" class="notice">…</my-notice>` when `ident` is `42` in the caller.

### Declared attributes (`b-attr`)

A custom element partial can declare attributes that double as context variables. On the definition tag, list each declared attribute with `b-attr:NAME`:

```html
<!-- definition -->
<my-widget b-attr:label b-attr:premium.bool>
    <h2>{{ label }}</h2>
    <p b-if="premium">Premium content!</p>
</my-widget>
```

Each `b-attr:NAME` makes `NAME` available as a context variable inside the partial body. The caller passes the value through a regular HTML attribute on the call tag — no `b-data:` needed:

```html
<my-widget label="Hello" :premium="user.isPremium"></my-widget>
```

The attribute is also rendered on the output tag (subject to the boolean rule below).

#### The `.bool` modifier

Without a modifier, the declared attribute is a **string** variable. Append `.bool` to declare it as a **boolean**:

```html
<my-widget b-attr:label b-attr:premium.bool>...</my-widget>
```

The modifier affects how the caller's value is coerced into the context (`String(...)` vs `Boolean(...)`) and how the rendered HTML attribute behaves: a boolean attribute is rendered as a bare `NAME` when truthy and omitted when falsy, mirroring the existing `b-bind:` boolean rule.

#### Call-site forms

For `b-attr:NAME` (string):

| Call site | Context value | Rendered |
|---|---|---|
| `<my-widget>` (omitted) | — *compile error* | — |
| `<my-widget premium>` (bare) | — *compile error* | — |
| `<my-widget premium="hello">` | `"hello"` | `premium="hello"` |
| `<my-widget :premium="expr">` | `String(expr)` | `premium="<value>"` |

For `b-attr:NAME.bool` (boolean):

| Call site | Context value | Rendered |
|---|---|---|
| `<my-widget>` (omitted) | — *compile error* | — |
| `<my-widget premium>` (bare) | `true` | bare `premium` |
| `<my-widget premium="hello">` | `true` (and **warning**: string used where bool expected) | `premium="hello"` |
| `<my-widget :premium="true">` | `true` | bare `premium` |
| `<my-widget :premium="false">` | `false` | omitted |
| `<my-widget :premium="expr">` | `Boolean(expr)` | bare `premium` if true, omitted if false |

`:NAME` and the long form `b-bind:NAME` behave identically.

#### Rules and errors

- `b-attr` is allowed only on a custom element partial **definition** tag. Using it on a `b-name` partial, on a call site, or on any nested element is a compile error.
- `b-attr:NAME` cannot have a value: `b-attr:NAME="x"` is reserved for future use and is an error.
- The only modifier currently supported is `.bool`.
- A declared attribute name cannot also appear as a plain attribute on the same definition tag (`<my-widget b-attr:foo foo="x">` is an error).
- The caller must provide every required `b-attr` on the call site; omitting one is an error.
- Using `b-data:NAME` on the call site when the partial declares `b-attr:NAME` is an error — pass the value as an attribute instead.
- Inside the partial body, a `b-attr` variable is a scalar (string or bool). Using it as an array, object, or iterable (`b-for`, member access, indexing) is a compile error.
- A boolean `b-attr` used directly in a `{{ }}` interpolation produces a warning. Use a string `b-attr` if you need to print the value, or convert explicitly. (No warning for the reverse: a string `b-attr` used in a boolean context like `b-if`.)
- `b-attr:NAME` should be all lowercase (hyphens are fine). HTML lowercases attribute names, so a name written as `b-attr:fooBar` is silently treated as `foobar`, and references to `fooBar` inside the partial body will not work. The compiler emits a warning when a `b-attr:` name contains uppercase letters.

### Client script (`b-script`)

A reactive custom element (one with `b-attr` declarations) usually pairs with a hand-coded web component on the client: a small module that imports the [generated dom-patch class](runtime-js.md#dom-patch-script-auto-include) and calls `customElements.define(...)`. Point the renderer at that module with `b-script` on the definition tag, using an [asset path](assets.md):

```html
<my-widget b-attr:count b-script="@scripts/my-widget.js">
	<span :data-count="count">{{ count }}</span>
</my-widget>
```

When a page renders `<my-widget>`, the renderer auto-includes `@scripts/my-widget.js` as `<script type="module">` (the **entry**), and `<link rel="modulepreload">` for the generated dom-patch module it imports (the **dependency**). See [JS runtime → auto-include](runtime-js.md#dom-patch-script-auto-include) for placement and ordering.

Rules:

- `b-script` is allowed only on a custom element partial **definition** tag. Using it elsewhere is a compile error.
- Its value is an asset path (`@name/subpath`); the asset directory must be configured (see [Assets](assets.md)) and the file must exist. At most one `b-script` per definition.
- A reactive partial with generated dom-patch code but no `b-script` builds with a warning — nothing would register its component.

### Conflicting attributes

If the same attribute name appears on both the call site and the definition (e.g. both set `class`), the compiler reports an error. Special handling for class merging is not yet implemented. Names declared via `b-attr:NAME` are exempt from this check — that's the whole point of `b-attr`.

### Flow control on call sites

`b-for`, `b-if`, `b-else-if`, and `b-else` can be placed directly on a custom element call tag — the call (and its slot content) is wrapped in the matching loop or branch:

```html
<my-greeting b-for="who in names" b-data:name="who"></my-greeting>

<my-notice b-if="warn"></my-notice>
<my-banner b-else-if="info"></my-banner>
<my-banner b-else b-data:tone="'quiet'"></my-banner>
```

The b-for variable (`who` above) is in scope for `b-data:*` bindings and slot content on the same call. b-else-if/b-else chain to a preceding b-if among siblings just like they do on regular tags, and the preceding b-if can be on a regular tag or another custom element call.

The equivalent `<b-unwrap b-for=...>` wrapping form is also supported and produces the same output — use whichever reads better in context:

```html
<b-unwrap b-for="who in names">
    <my-greeting b-data:name="who"></my-greeting>
</b-unwrap>
```
