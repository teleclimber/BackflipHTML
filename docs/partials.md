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

### Conflicting attributes

If the same attribute name appears on both the call site and the definition (e.g. both set `class`), the compiler reports an error. Special handling for class merging is not yet implemented.

### Flow control on call sites

`b-if` and `b-for` are not valid directly on a custom element call tag — wrap the call in `<b-unwrap>`:

```html
<b-unwrap b-for="who in names">
    <my-greeting b-data:name="who"></my-greeting>
</b-unwrap>
```
