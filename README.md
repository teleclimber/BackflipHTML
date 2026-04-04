# BackflipHTML

BackflipHTML is an HTML templating system that supports generating output in multiple languages. You write HTML with special `b-*` directive attributes and `{{ expression }}` interpolations using a subset of JavaScript, and the system compiles it into JS or PHP files. A lightweight runtime generates HTML from these outputs.

(For now only JS and PHP are supported. Go is coming later. Other languages can be supported fairly easily.)

## How it works

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
        ├─────────────────────────────┐
        ▼                             ▼
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

The compile step only needs to run once per template. The resulting module can be cached and reused, with only the lightweight runtime render pass running per request.

## Subprojects

### [`compiler/`](compiler/README.md)

Parses HTML templates into a language-agnostic AST and generates JS or PHP source files from it.

### [`runtime/`](runtime/README.md)

Streaming HTML renderers in JS and PHP that execute compiled templates with a data context.

## Developer Tooling Subprojects

### [`css/`](css/README.md)

Matches CSS selectors to template elements, accounting for partials, conditionals, and dynamic attributes. Used by the LSP.

### [`lsp/`](lsp/README.md)

Language Server providing diagnostics, go-to-definition, find references, hover, and document symbols for templates and CSS.

### [`preview/`](preview/README.md)

Local dev server that renders partials with auto-generated mock data and live reload.

### [`vscode-backflip/`](vscode-backflip/README.md)

VSCode extension providing syntax highlighting, language server integration, and a preview panel for templates.

## Documentation

- [Directives reference](docs/directives.md) — all `b-*` directives and the expression language
- [Partials](docs/partials.md) — defining, including, and composing partials with slots
- [Assets](docs/assets.md) — configuring and referencing static assets like images and styles
- [CLI](docs/cli.md) — compiling templates from the command line
- [Configuration](docs/configuration.md) — `backflip.json` reference
- [JS runtime](docs/runtime-js.md) — JavaScript runtime API and usage
- [PHP runtime](docs/runtime-php.md) — PHP runtime API and usage
- [Dual-runtime support](docs/dual-runtime.md) — using from Deno vs Node.js

### Developer Tooling Docs

- [Preview](docs/preview.md) — preview system, programmatic API, VSCode integration


## Testing

From the repo root, run compiler, runtime, preview, and integration tests via Deno:

```bash
deno task test
```

### Integration Tests [`test/`](test/README.md)

End-to-end integration tests for the full compile → generate → render pipeline.

PHP integration tests require `php` in PATH. CLI tests spawn `deno` subprocesses.

### LSP and CSS

The LSP and CSS packages have their own test suites — see their READMEs for details.


