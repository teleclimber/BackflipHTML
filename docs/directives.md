# Directives

Directives are special attributes (and one special element) that the compiler recognizes and compiles away. They are not present in the rendered HTML output — they are instructions evaluated at render time to produce dynamic content.

---

## `{{ expression }}` — text interpolation

Write `{{ expr }}` inside element text content to insert a dynamic value.

```html
<p>Hello, {{ user.name }}!</p>
```

The output is HTML-escaped. The expression is evaluated in the current data context and the result is inserted as text.

See [Expression language](#expression-language) below for what expressions are allowed.

---

## `b-for` — loop

Syntax: `b-for="item in collection"`

The element is repeated once per item in `collection`. `item` is a new variable scoped to the element's subtree.

```html
<li b-for="post in posts">{{ post.title }}</li>
```

`collection` is an expression evaluated in the current context. `item` is the name bound to each element of the collection during iteration.

**Error:** the attribute value must match the `item in collection` form exactly.

---

## `b-if` / `b-else-if` / `b-else` — conditional rendering

`b-if`, `b-else-if`, and `b-else` form a single conditional block. Only the first truthy branch renders.

**`b-if="expr"`** — renders the element if `expr` is truthy.

```html
<p b-if="user.isAdmin">Admin panel</p>
```

**`b-else-if="expr"`** — must immediately follow a `b-if` or `b-else-if` element. Renders if `expr` is truthy and all preceding branches were falsy.

```html
<p b-if="user.isAdmin">Admin panel</p>
<p b-else-if="user.isMod">Mod panel</p>
```

**`b-else`** — takes no value. Must immediately follow a `b-if` or `b-else-if` element. Renders when all preceding branches are falsy.

```html
<p b-if="user.isAdmin">Admin panel</p>
<p b-else-if="user.isMod">Mod panel</p>
<p b-else>No access</p>
```

All three directives compile to a single `IfTNode`. They can be nested freely inside `b-for` blocks and other `b-if` blocks.

**Errors:**
- `b-else` or `b-else-if` without a preceding `b-if` element
- `b-else` given a value

---

## `b-bind:` / `:` — attribute binding

Syntax: `b-bind:attrname="expression"` or the shorthand `:attrname="expression"`

Dynamically sets an HTML attribute value from an expression.

```html
<a :href="url">Link</a>
<img :src="avatar" :alt="user.name">
```

Multiple bindings can appear on the same element:

```html
<input type="checkbox" :checked="isChecked" :disabled="isDisabled">
```

**Boolean attributes** (e.g. `checked`, `disabled`, `readonly`, `selected`) are treated specially: when the expression is truthy the attribute name is rendered with no value; when falsy the attribute is omitted entirely.

```html
<!-- isChecked=true  → <input type="checkbox" checked> -->
<!-- isChecked=false → <input type="checkbox"> -->
<input type="checkbox" :checked="isChecked">
```

**Non-boolean attributes** are omitted when the expression evaluates to `null`, `undefined`, or `false`; otherwise the value is HTML-escaped and rendered as `attrname="value"`.

```html
<!-- cls="active" → <div class="active"> -->
<!-- cls=false    → <div> -->
<div :class="cls"></div>
```

---

## `<b-unwrap>` — wrapper-free rendering

`<b-unwrap>` is a special element that renders its children without itself. It is not a real HTML tag and never appears in the output.

Use it when you need a directive target but don't want an extra wrapper element in the rendered HTML:

```html
<b-unwrap b-for="post in posts">
    <h2>{{ post.title }}</h2>
    <p>{{ post.body }}</p>
</b-unwrap>
```

```html
<b-unwrap b-if="user.isAdmin">
    <p>Admin panel</p>
</b-unwrap>
```

`<b-unwrap>` works with all directives. It is also used in the partials system — see [`docs/partials.md`](partials.md).

---

## Expression language

Expressions in directives and `{{ }}` interpolations are handled by `backcode.ts`, which uses `acorn` to parse them as a safe subset of JavaScript.

**Allowed:**

| Construct | Example |
|---|---|
| Identifier | `name` |
| String literal | `"hello"` |
| Number literal | `42` |
| Boolean literal | `true` |
| Member access | `user.name` |
| Computed member access | `items[0]` |

**Not allowed:** function calls, operators, object/array literals, assignment, or any other construct not listed above.

---

## Compilation errors

The compiler reports errors for:

- `b-for` value not in `item in collection` form
- `b-else` or `b-else-if` without a preceding `b-if` element
- `b-else` given a value
- Multiple `b-*` directives on the same element
