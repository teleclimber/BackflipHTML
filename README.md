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

### [`assets/`](assets/README.md)

Handles the discovery, tracking, and reporting of static assets referenced in BackflipHTML templates and CSS.

### [`css/`](css/README.md)

Matches CSS selectors to template elements, accounting for partials, conditionals, and dynamic attributes. Used by the LSP.

### [`lsp/`](lsp/README.md)

Language Server providing diagnostics, go-to-definition, find references, hover, and document symbols for templates and CSS.

### [`preview/`](preview/README.md)

Local dev server that renders partials with auto-generated mock data and live reload.

### [`vscode-backflip/`](vscode-backflip/README.md)

VSCode extension providing syntax highlighting, language server integration, and a preview panel for templates.

### [`dev-explainers/`](dev-explainers/README.md)

Tools that show how a subsystem reaches its results, for people working on that subsystem. Not shipped.

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


## Building

```bash
npm run build            # compiler + runtime + preview -> dist/
npm run build:extension  # the above, plus the LSP server and the VS Code .vsix
```

`build:extension` is the full build. It runs the root `tsc`, then
`vscode-backflip`'s build (which builds the LSP server via `lsp/build.mjs` and
copies `server.cjs` into the extension), then packages
`vscode-backflip/vscode-backflip-0.1.0.vsix`.

Install the result with:

```bash
code --install-extension vscode-backflip/vscode-backflip-0.1.0.vsix --force
```

then reload the VS Code window. **The extension loads its own bundled copy of
the server**, so editing `lsp/src/` changes nothing in the editor until you
rebuild *and* reinstall — a rebuilt `vscode-backflip/server/server.cjs` on its
own is not what VS Code runs.

Packaging needs `@vscode/vsce`, a devDependency of `vscode-backflip`. If
`npm run build:extension` ends in `vsce: not found`, run `npm install` in
`vscode-backflip/`. Note that failure comes *last*, after every compile step has
already succeeded — so the artifacts all look freshly built while the `.vsix`
silently stays stale.

## Testing

From the repo root, run compiler, runtime, preview, and integration tests via Deno:

```bash
deno task test
```

### Integration Tests [`test/`](test/README.md)

End-to-end integration tests for the full compile → generate → render pipeline.

PHP integration tests require `php` in PATH. CLI tests spawn `deno` subprocesses.

### LSP, CSS, and dev explainers

The LSP, CSS, and `dev-explainers` packages have their own test suites — see their READMEs for details.

### Keeping npm dependencies in sync with `deno.json`

The subprojects are npm packages with their own `package.json` and
`node_modules`, but Deno type-checks any of them its module graph reaches — and
the two toolchains resolve npm dependencies differently:

| | resolves an npm import via |
|---|---|
| `tsc`, `node`, the per-package tests | the nearest `node_modules/`, i.e. the subproject's own |
| `deno task test` | the `imports` map in `deno.json` |

So for any subproject in Deno's graph, every npm dependency it shares with
`deno.json` has to be bumped in both places. When they drift, `npm test` and
`npm run build` keep passing while `deno task test` fails to type-check against
whichever version Deno picked — a confusing way to find out, because the code is
correct for the version it actually runs against.

Which subprojects are in the graph is a property of the imports, not of the
config. Today `preview/server.ts` reaches into `assets/` and `css/`, so those
two are checked; `lsp/`, `dev-explainers/` and `vscode-backflip/` are not
reachable from any Deno entry point and are checked only by their own
toolchains. Adding one import can change that.

Note that the `exclude` list in `deno.json` does **not** prevent this. It
governs which files Deno lints and tests directly, not what a transitive import
drags into the graph — `css/` is in that list and was still being type-checked
against the wrong `css-select`.

To see what Deno actually pulls in:

```bash
deno info preview/server.ts
```


