# BackflipHTML

BackflipHTML is an HTML templating system that supports generating output from multiple languages. You write HTML with special `b-*` directive attributes and `{{ expression }}` interpolations using a subset of JavaScript, and the system compiles it into a language agnostic representation. It can then produce outputs for use in different environments, such as JS, PHP, Go (JS only for now).

The pipeline has three stages, each living in its own subfolder:

---

## `compiler/`

The entry point for processing a template. It takes a raw HTML string as input and produces an **AST (abstract syntax tree)** — a structured language agnostic representation of the template.

It uses `parse5`'s streaming HTML parser under the hood, so it handles real HTML (including void elements, self-closing tags, etc.) rather than doing naive string matching. As it walks the HTML, it recognizes the `b-for`, `b-if`, `b-else-if`, and `b-else` directive attributes and builds tree nodes for them. Anything that isn't a directive gets stored as a raw HTML string node. See [`docs/directives.md`](docs/directives.md) for a full reference.

`backcode.ts` within this folder handles the expression language used in directives and `{{ }}` interpolations. It uses `acorn` to parse expressions as a subset of JavaScript, validates that only safe/allowed constructs are used (identifiers, literals, member access), and extracts the list of variable names the expression depends on.

**Generates** an AST representation of the template that can be consumed in the following steps.

---

## `compiler/generate/*/`

Generates code from the compiler output.

`generatejs` turns the language-agnostic AST into one that can be consumed directly in JavaScript.

All expressions are compiled into real JS functions. This is done in two layers:

- `generatejs.ts` handles individual expressions: it turns a `Parsed` expression object into a JS function string (e.g. `function(item) { return item.name; }`)
- `nodes2js.ts` handles the full tree: it walks the `TNode` tree and emits a JS object literal that mirrors the structure expected by `renderjs`, with each expression replaced by a `{ fn: ..., vars: [...] }` object

The output is a JS module (via `nodeToJsExport`) that can be loaded directly and passed to `renderjs` for rendering.

**Output:** a JavaScript source string that, when evaluated, produces an `RNode` tree ready for `renderjs`.

---

## `runtime/*/`

The runtime renderer (specifically for JS). It takes a tree structure where every expression is already a callable JS function — plus a **data context object**, and walks the tree to produce the final HTML string.

- `raw` nodes are passed through as-is
- `print` nodes call their function with values pulled from the context and insert the result
- `for` nodes iterate over a value from the context, rendering child nodes once per item with an augmented context
- `if` nodes evaluate each branch's function in order and render the first truthy branch

**Input:** an `RNode` tree (produced by evaluating `generatejs/`'s output) + a data context object
**Output:** a rendered HTML string.

---

## How they fit together

```
HTML template string
        │
        ▼
  [ compiler/ ]  ──── parses HTML, recognizes b-* directives,
                       interprets expressions via backcode.ts
        │
        ▼
   RootTNode AST (expressions as parsed AST objects)
        │
        ▼
  [ compiler/generate/js/ ] ─── converts TNode tree → JS source string
        │               with expressions compiled to real functions
        ▼
   Emitted JS module (RNode-shaped object literal)
        │
        ▼
  [ runtime/js/ ]  ──── walks RNode tree + data context → HTML string
```

The compile step (`compiler/` + `compiler/generate/js/`) only needs to run once per template. The resulting JS module can be cached and reused, with only the lightweight `runtime/js/` render pass running per request.
