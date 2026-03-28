# BackflipHTML

BackflipHTML is an HTML templating system that supports generating output in multiple languages. You write HTML with special `b-*` directive attributes and `{{ expression }}` interpolations using a subset of JavaScript, and the system compiles it into JS or PHP files. A lightweight library generates HTML from these outputs.

(For now only JS and PHP are supported. Go is coming later. Other languages can be supported fairly easily.)

The pipeline has three stages, each living in its own subfolder:

---

## `compiler/`

The entry point for processing a template. It takes a raw HTML string as input and produces an **AST (abstract syntax tree)** — a structured language agnostic representation of the template.

It uses `parse5`'s streaming HTML parser under the hood, so it handles real HTML (including void elements, self-closing tags, etc.) rather than doing naive string matching. As it walks the HTML, it recognizes the `b-for`, `b-if`, `b-else-if`, and `b-else` directive attributes and builds tree nodes for them. Anything that isn't a directive gets stored as a raw HTML string node. See [`docs/directives.md`](docs/directives.md) for a full reference.

`backcode.ts` within this folder handles the expression language used in directives and `{{ }}` interpolations. It uses `acorn` to parse expressions as a subset of JavaScript, validates that only safe/allowed constructs are used (identifiers, literals, member access), and extracts the list of variable names the expression depends on.

The output of the compiler is an AST representation of the template that can be consumed in the following steps.

---

## `compiler/generate/*/`

Generates code from the compiler output. Each subdirectory targets a different output language.

### `compiler/generate/js/`

`generatejs` turns the language-agnostic AST into one that can be consumed directly in JavaScript.

All expressions are compiled into real JS functions. This is done in two layers:

- `generatejs.ts` handles individual expressions: it turns a `Parsed` expression object into a JS function string (e.g. `function(item) { return item.name; }`)
- `nodes2js.ts` handles the full tree: it walks the `TNode` tree and emits a JS object literal that mirrors the structure expected by `renderjs`, with each expression replaced by a `{ fn: ..., vars: [...] }` object

The output is a JS module (via `nodeToJsExport`) that can be loaded directly and passed to `renderjs` for rendering.

**Output:** a JavaScript source string that, when evaluated, produces an `RNode` tree ready for `renderjs`.

### `compiler/generate/php/`

`generatephp` turns the language-agnostic AST into a PHP file that can be consumed by `runtime/php/`.

All expressions are compiled into PHP closures. This is done in two layers:

- `generatephp.ts` handles individual expressions: it turns a `Parsed` expression object into a PHP closure string (e.g. `function($item) { return $item['name']; }`). Member access uses PHP associative array syntax — `user.name` becomes `$user['name']`.
- `nodes2php.ts` handles the full tree: it walks the `TNode` tree and emits a PHP file where each partial is a PHP array variable with the same structure as the JS output, with each expression replaced by a `['fn' => ..., 'vars' => [...]]` array. Cross-file partial references are loaded via `backflip_require()`. The file ends with `return compact(...)` so it can be loaded as a module.

**Output:** a `.php` source file that, when loaded via `backflip_require()`, returns an associative array of partial node trees ready for `runtime/php/`.

---

## `runtime/*/`

The runtime renderer. It takes a tree structure where every expression is already a callable function — plus a **data context**, and walks the tree to produce HTML.

Internally, the renderer is **streaming-first**: all rendering is done via generators that `yield` string chunks as they walk the tree. This means HTML can be emitted incrementally — useful for large templates or server-sent responses.

Two public APIs are provided in each language:

- **`renderRoot`** — returns the complete HTML as a single string (wraps the streaming internals).
- **`streamRenderRoot`** — returns a generator that yields string chunks incrementally.

Node types handled:

- `raw` nodes are passed through as-is
- `print` nodes call their function with values pulled from the context and insert the result
- `for` nodes iterate over a value from the context, rendering child nodes once per item with an augmented context
- `if` nodes evaluate each branch's condition in order and render the first truthy branch
- `partial-ref` nodes evaluate bindings in the caller's context, then render the referenced partial with a child context and slot map
- `slot` nodes render injected content in the caller's original context

### `runtime/js/`

**Input:** an `RNode` tree (produced by evaluating `generatejs/`'s output) + a data context object
**Output:** a rendered HTML string via `renderRoot`, or a `Generator<string>` via `streamRenderRoot`.

### `runtime/php/`

`render.php` provides a set of `backflip_*` functions that implement the same logic in PHP 8.1+. Key details:

- Truthiness follows **JavaScript semantics**, not PHP's: `"0"` and `[]` are truthy (use `backflip_isTruthy()` — never a bare PHP boolean cast).
- `backflip_require($path)` loads generated PHP files with static caching, working around PHP's `require_once` returning `1` on repeat calls.
- `backflip_renderRoot` returns a string; `backflip_streamRenderRoot` returns a `Generator` that yields string chunks.

**Input:** a node tree array (produced by loading a `generatephp/`-emitted `.php` file) + a data context array
**Output:** a rendered HTML string via `backflip_renderRoot`, or a `Generator` via `backflip_streamRenderRoot`.

---

## Configuration

Create a `backflip.json` file at the root of your project:

```json
{
  "root": "src/templates",
  "output": "dist",
  "lang": "js",
  "stylesheet": "styles/global.css"
}
```

| Field        | Required | Description                                          |
|--------------|----------|------------------------------------------------------|
| `root`       | Yes      | Relative path to the directory containing `.html` templates |
| `output`     | No       | Relative path to the output directory (used by CLI)  |
| `lang`       | No       | Output language: `"js"` or `"php"` (used by CLI)    |
| `stylesheet` | No       | Relative path to a global CSS stylesheet  (for ref only)  |

The **LSP server** requires this file — without `backflip.json` in the workspace root, the language server stays inactive (no diagnostics, no go-to-definition, etc.).

The **CLI** reads it as a fallback when no arguments are provided. With a `backflip.json` in your working directory, you can simply run:

```bash
backflip              # compile using config
backflip --check      # check for errors using config
```

CLI arguments override config values when both are present.

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
        ├─────────────────────────────────┐
        ▼                                 ▼
  [ compiler/generate/js/ ]     [ compiler/generate/php/ ]
  converts TNode tree →         converts TNode tree →
  JS source string              PHP source file
        │                                 │
        ▼                                 ▼
  Emitted JS module             Emitted .php file
  (RNode-shaped object)         (array of node trees)
        │                                 │
        ▼                                 ▼
  [ runtime/js/ ]               [ runtime/php/ ]
  walks tree + JS context       walks tree + PHP array context
  → Generator<string> chunks    → Generator chunks
    or collected HTML string      or collected HTML string
```

The compile step (`compiler/` + `compiler/generate/*/`) only needs to run once per template. The resulting module can be cached and reused, with only the lightweight runtime render pass running per request.

---

## Testing

### Compiler & Runtime (Deno)

From the repo root:

```bash
deno task test
```

This runs `deno test --allow-read --allow-write --allow-run=php,deno` and covers the compiler, code generators, JS runtime, and integration tests.

- Integration PHP tests require `php` in PATH.
- CLI tests spawn `deno` subprocesses.

### LSP (Node.js)

```bash
cd lsp && npm install && npm test
```

This runs `node --import tsx --test src/*.test.ts` — unit tests for diagnostics, go-to-definition, references, symbols, hover, and parsing.

### VSCode Extension

No tests — thin wrapper that launches the LSP server.

---

## Dual-Runtime Support

The compiler, generators, and runtime are importable from both **Deno** and **Node.js**.

- **Deno**: import directly from `mod.ts` — bare specifiers like `acorn` and `parse5-html-rewriting-stream` are mapped via `deno.json` import maps.
- **Node.js**: run `npm run build` to compile to `dist/`, then import from `dist/mod.js`. The `package.json` exports field points here.

```bash
# Node.js
npm install && npm run build
node -e "import('./dist/mod.js').then(m => console.log(Object.keys(m)))"
```

---

## `lsp/`

A **Language Server Protocol** implementation (Node.js) that provides IDE features for BackflipHTML templates:

- **Diagnostics** — red underlines for template compilation errors
- **Go to Definition** — click a `b-part` reference to jump to the `b-name` definition
- **Find All References** — from a `b-name` definition, find all `b-part` usages
- **Document Symbols** — lists partials in the editor outline/breadcrumbs
- **Hover (HTML)** — hover over `b-part`, `b-name`, `b-in`, `b-slot`, `b-data:` attributes or HTML elements to see directive info and matching CSS rules
- **Hover (CSS)** — hover over a selector in the stylesheet to see which partials contain matching elements, with clickable links to jump to each element

The server reuses the compiler's AST and source location tracking. On file open/save, it reads `backflip.json` from the workspace root to find the template directory, runs `compileDirectory()` on it, and builds a project index of partial definitions and references. The server stays inactive if no `backflip.json` is found.

```bash
cd lsp && npm install && npm run build
```

---

## `preview/`

A standalone **partial preview** module that renders partials with auto-generated mock data. No backend or real data required — the preview infers what data each partial needs from its data shape and generates plausible values. See [`docs/preview.md`](docs/preview.md) for details.

- Generates mock data from `DataShape` (printed → variable name string, boolean → `true`, iterable → array of 3 items, attributes → sensible defaults)
- Resolves data shapes across `b-part` references (looks up the called partial's requirements)
- Fills slots with grey placeholder blocks
- Includes the project's global CSS from `backflip.json` `stylesheet`
- Handles document-level partials (`<html>`, `<body>`) without double-wrapping
- Available as a programmatic API and via the VSCode extension

---

## `vscode-backflip/`

A **VSCode extension** that launches the BackflipHTML language server and provides:

- TextMate grammar injection for `b-*` directive highlighting and `{{ }}` interpolation
- Language configuration for bracket matching and auto-closing pairs
- **Preview Partial** command — right-click in an HTML template or use the Command Palette to open a live preview panel

### Building & installing

From the repo root, build and package everything in one step:

```bash
npm run build:extension
```

This builds the compiler, LSP server, and extension, then packages it as a `.vsix` file. Install the resulting `vscode-backflip/vscode-backflip-0.1.0.vsix` via the command palette (**Extensions: Install from VSIX...**) or:

```bash
code --install-extension vscode-backflip/vscode-backflip-0.1.0.vsix
```

For **remote development** (SSH, WSL, Dev Containers), the extension must be installed on the remote side — the LSP server needs direct access to the project files. Build and install the `.vsix` on the remote host, then install it while connected to the remote.
