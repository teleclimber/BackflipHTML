# Partials

Partials are reusable HTML fragments. You define them in `.html` files, then include them from other templates. The compiler resolves partial references and produces one JavaScript module per HTML file, so you only load what you need at render time.

---

## Template files

Partial files are plain HTML fragments — no `<html>`, `<head>`, or `<body>` tags. One file can contain multiple partials. File names are arbitrary.

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

- `b-name` on a non-top-level element
- A `b-part` reference that cannot be resolved (partial not found)
- A cross-file `b-part` reference to a partial that exists but lacks `b-export`
- A named slot reference (`b-in="name"`) where the partial has no matching `b-slot="name"`
- Default slot content provided to a partial that declares no default slot
- Circular cross-file dependencies (A includes B which includes A)
