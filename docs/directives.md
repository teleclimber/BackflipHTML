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

**Client-side reactivity.** Inside a custom-element partial, a `b-if` set whose conditions are driven by `b-attr` variables re-renders in the browser when those attributes change — the branch is rendered client-side and swapped into place. Sets may be **nested**: an inner set becomes its own patch unit, so changing an inner condition re-renders just the inner branch, and content inside a rendered branch keeps patching. This applies to a set that is:

- not inside a `b-for`;
- driven only by `b-attr` variables in its own branch conditions — an expression elsewhere in the set, or a condition mixing in a non-`b-attr` variable, disqualifies the whole set;
- free of partial references, custom-element calls, slots, and asset references anywhere in its subtree.

Nested `b-for` is fine inside a reactive set; it is re-rendered as part of the branch that owns it. A set that doesn't meet these conditions still renders correctly server-side — it just stays frozen in the browser. See the [dom-patch generator](../compiler/generate/dom-patch/README.md) for the full rules.

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

**Static attributes** (no binding) are re-emitted byte-for-byte as written — the quote style, the name's case, and any character references are all preserved:

```html
<!-- renders exactly as written -->
<a href='single' title="double" rel=unquoted data-x='say "hi"' href2="?a=1&amp;b=2">
```

Valueless attributes stay valueless too: `<input disabled>` renders as `<input disabled>`, while an explicit `<input disabled="">` keeps its empty value.

Bound attributes are a different story — `:href="expr"` has no source value to preserve, so its rendered value is HTML-escaped and always double-quoted (see above). The same goes for the resolved value of an asset attribute (`src~`), though there the *quote style* still carries over from the source: `src~='@images/logo.png'` renders as `src='/img/logo.png'`. An unquoted asset attribute resolves to a double-quoted one, since the resolved path is not guaranteed to stay quote-free.

---

## Asset References (`~`)

Append a tilde `~` to any attribute name (including bound attributes) to resolve asset paths against configured asset directories.

```html
<img src~="@images/logo.png">
<img :src~="'@images/' + filename">
```

See [Assets](assets.md) for configuration and detailed usage.

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
| Unary operators | `!hidden`, `-offset`, `+value` |
| Equality operators | `a == b`, `a != b` |
| Relational operators | `a < b`, `a > b`, `a <= b`, `a >= b` |
| Plus operator | `a + b`, `'Hello, ' + name` |
| Ternary | `admin ? name : "guest"` |

The `+` operator works for both numeric addition and string concatenation. Relational operators follow JavaScript's Abstract Relational Comparison: two strings compare lexicographically, otherwise both sides are coerced to numbers and any `NaN` makes the result `false`. The JS and PHP backends produce identical results.

**Not allowed:** function calls, other binary operators (`===`, `&&`, `||`, etc.), object/array literals, assignment, or any other construct not listed above.

---

## Compilation errors

The compiler reports errors for:

- `b-for` value not in `item in collection` form
- `b-else` or `b-else-if` without a preceding `b-if` element
- `b-else` given a value
- Multiple `b-*` directives on the same element
