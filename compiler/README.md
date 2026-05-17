# Compiler

The compiler takes HTML templates with `b-*` directive attributes and `{{ expression }}` interpolations and produces a language-agnostic AST (abstract syntax tree). Code generators then convert the AST into JavaScript or PHP source files.

## Components

### Parser (`compiler.ts`)

The main compilation entry point. Uses `parse5`'s streaming HTML parser to handle real HTML (void elements, self-closing tags, etc.). As it walks the HTML, it recognizes `b-for`, `b-if`, `b-else-if`, `b-else`, `b-bind:`, `b-name`, `b-part`, `b-slot`, `b-in`, `b-data:`, and `b-unwrap` directives and builds tree nodes for each. Anything that isn't a directive is stored as a raw HTML string node.

Key function:

- `compilePartial()` — compiles a single partial's HTML slice (paired with its `PartialDef`) into a `RootTNode`. The file-level pipeline lives in `partials.ts` (`scanPartials` → slice per def → `compilePartial`).

### TNode taxonomy (`types.ts`)

The AST is a tree of `TNode`s under a `RootTNode`. Each variant models one structural concern:

- `RawTNode` — pre-rendered HTML text (escaped at parse time as needed).
- `PrintTNode` — `{{ expr }}` interpolation (escaped at render time).
- `ElementTNode` — an HTML element: `tagName`, `attrs: AttrPart[]` (mixed `static` / `dynamic` / `asset`), and `tnodes` (body content). Carries source locations (`openTagLoc`, `closeTagLoc`, `loc`) for LSP and Phase 5 flatten.
- `ForTNode` / `IfTNode` (with `IfBranch`) — flow control, holding nested `tnodes`.
- `SlotTNode` — slot insertion point.
- `PartialRefTNode` — discriminated by `kind: 'b-part' | 'custom-element'`. The `BPartCallTNode` variant references another partial; its wrapping element (if any) is an enclosing `ElementTNode` in the tree. The `CustomElementCallTNode` variant carries `callerAttrs: AttrPart[]` for the call-site attrs that the runtime merges with the definition's `definitionAttrs`.

`AttrPart` itself is `static` (literal text), `dynamic` (runtime-evaluated expression), or `asset` (compile-time-resolved `@name/...` URL). The `resolveAssetRefs()` pass replaces `asset` parts with `static` parts after compilation.

### Expression language (`backcode.ts`)

Handles expressions used in directives and `{{ }}` interpolations. Uses `acorn` to parse expressions as a safe subset of JavaScript (identifiers, literals, member access, unary operators). Validates that only allowed constructs are used and extracts the list of variable names each expression depends on.

### Cross-file compilation (`partials.ts`)

Orchestrates compilation of all HTML files in a directory. Manages cross-file partial references, dependency resolution, and cycle detection.

- `compileDirectory()` — compiles all `.html` files in a directory and returns a `CompiledDirectory`

### Data shape inference (`data-shape.ts`)

Infers the types and usage patterns of template variables by analyzing how they appear in the AST. Tracks whether variables are used as iterables, booleans, printed values, attribute bindings, or passed to child partials. Used by the preview system to generate mock data.

### Configuration (`config.ts`)

Loads and validates `backflip.json` project configuration files. See [`docs/configuration.md`](../docs/configuration.md).

### Code generators ([`generate/`](generate/))

Convert the language-agnostic AST into target-language source files. Each generator works the same way — one module handles individual expressions, another walks the full tree and emits a source file — just in different languages:

- **[`generate/js/`](generate/js/README.md)** — produces JavaScript ES modules
- **[`generate/php/`](generate/php/README.md)** — produces PHP files

## Usage docs

- [Directives reference](../docs/directives.md) — all `b-*` directives and the expression language
- [Partials](../docs/partials.md) — defining, including, and composing partials with slots
- [CLI](../docs/cli.md) — compiling templates from the command line
- [Configuration](../docs/configuration.md) — `backflip.json` reference

## Testing

Compiler and generator tests run via Deno from the repo root:

```bash
deno task test
```

Test files:

| File | Covers |
|------|--------|
| `compiler_test.ts` | HTML parsing, directive recognition, AST structure |
| `partials_test.ts` | Cross-file compilation, dependency resolution, cycle detection |
| `data-shape_test.ts` | Variable usage inference |
| `data-shape-integration_test.ts` | Data shape across partials |
| `generate/js/generatejs_test.ts` | Expression → JS function |
| `generate/js/nodes2js_test.ts` | AST → JS module |
| `generate/php/generatephp_test.ts` | Expression → PHP closure |
| `generate/php/nodes2php_test.ts` | AST → PHP file |
