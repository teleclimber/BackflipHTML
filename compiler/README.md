# Compiler

The compiler takes HTML templates with `b-*` directive attributes and `{{ expression }}` interpolations and produces a language-agnostic AST (abstract syntax tree). Code generators then convert the AST into JavaScript or PHP source files.

## Components

### Parser (`compiler.ts`, `parse-tree.ts`, `lower.ts`)

Compilation of one partial runs in two passes:

1. **Parse (`parse-tree.ts`)** — `buildSourceTree()` consumes `parse5`'s SAX events (so real HTML — void elements, self-closing tags, etc. — is handled correctly) and builds a dumb, faithful source tree of elements and text with attributes, raw tag text, and source locations. It has no directive knowledge. This is also the single place where parse5 source locations are converted to `SourceLoc`.
2. **Lower (`lower.ts`)** — `lowerSlice()` recursively transforms the source tree into the compiled TNode AST. All directive semantics live here: `b-for`, `b-if`, `b-else-if`, `b-else`, `b-bind:`, `b-name`, `b-part`, `b-slot`, `b-in`, `b-data:`, `b-unwrap`, and `{{ }}` interpolation. Anything that isn't a directive is stored as a raw HTML string node.

`compiler.ts` is the thin public wrapper:

- `compilePartial()` — compiles a single partial's HTML slice (paired with its `PartialDef`) into a `RootTNode` by running the two passes and validating the result against the `PartialDef`. The file-level pipeline lives in `partials.ts` (`scanPartials` → slice per def → `compilePartial`).

### TNode taxonomy (`types.ts`)

The AST is a tree of `TNode`s under a `RootTNode`. Each variant models one structural concern:

- `RawTNode` — pre-rendered HTML text (escaped at parse time as needed).
- `CommentTNode` — an HTML comment (`<!--text-->`), emitted verbatim. Not produced by the parser; inserted by the [`dom-patch`](generate/dom-patch/README.md) pass as range markers around patchable children.
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
- **[`generate/dom-patch/`](generate/dom-patch/README.md)** — produces browser-side patcher classes for custom-element partials with reactive attributes; mutates the AST so server-rendered HTML carries the matching `data-bfid` markers

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
| `integration_tests/backcode_test.ts` | Cross-language runtime equivalence for compiled backcode expressions |

### Cross-language runtime equivalence (`integration_tests/`)

`backcode_test.ts` is the harness that compiles each test's backcode string with every code generator, runs it under each target runtime, and asserts that all runtimes produce the same value. JS is the reference language; non-JS runtimes (currently PHP) must match it. Test cases live in `backcode_cases.ts` — a flat list of `{ code, inputs, expected }` records covering operator semantics (`==`, `+`, `!`, ternary, member access) and their compositions, focused on the kinds of inputs where JS and other languages tend to disagree (mixed-type equality, `+` concat vs add, `'0'` truthiness, etc.).

The PHP runtime spawns one `php -r` subprocess per case; if `php` isn't in PATH the harness skips PHP with a warning instead of failing.

To add another target language, create `integration_tests/backcode_runtime_<lang>.ts` exporting a `Runtime` (see `backcode_runtime.ts`), then import it from `backcode_test.ts` and push it into the `runtimes` list. No changes to the case fixture are needed — every existing case automatically covers the new language.
