# Language Server (LSP)

`@backflip/lsp` is a Language Server Protocol implementation that provides IDE features for BackflipHTML templates. It is used by the [VSCode extension](../vscode-backflip/) but can work with any LSP-compatible editor.

## Features

- **Diagnostics** — red underlines for template compilation errors
- **Go to Definition** — click a `b-part` reference to jump to the `b-name` definition, or click a custom element partial tag (e.g. `<my-card>`) to jump to its definition
- **Find All References** — from a `b-name` definition, find all `b-part` usages
- **Document Symbols** — lists partials in the editor outline/breadcrumbs
- **Hover (HTML)** — hover over `b-part`, `b-name`, `b-in`, `b-slot`, `b-data:` attributes, custom element partial tags (e.g. `<my-card>`), or HTML elements to see directive info and matching CSS rules
- **Hover (CSS)** — hover over a selector in a CSS file to see which partials contain matching elements

## How it works

The server requires a `backflip.json` in the workspace root to activate (see [`docs/configuration.md`](../docs/configuration.md)). On file open/save, it runs `compileDirectory()` on the template directory and builds a project index of partial definitions and references. CSS analysis is provided by [`@backflip/css`](../css/README.md) — CSS files are automatically discovered from configured asset directories.

File changes trigger recompilation with a 300ms debounce. The server also watches for `backflip.json` changes to reload configuration.

## Key files

| File | Purpose |
|------|---------|
| `src/server.ts` | LSP connection setup, all request/notification handlers |
| `src/index.ts` | Project indexing: maps partial definitions and references |
| `src/hover.ts` | Hover information for directives and CSS selectors |
| `src/definition.ts` | Go-to-definition for `b-part` → `b-name` |
| `src/references.ts` | Find-references for partial usage |
| `src/symbols.ts` | Document symbols: lists partials in file |
| `src/diagnostics.ts` | Compilation error → LSP diagnostic conversion |
| `src/parse-bpart.ts` | Parses `b-part` attribute values (e.g. `file.html#name`) |
| `build.mjs` | Rollup build script (bundles to `dist/server.cjs`) |

## Setup

```bash
cd lsp
npm install
```

## Building

```bash
cd lsp
npm run build
```

This bundles the server into `dist/server.cjs` using Rollup with SWC transpilation.

## Testing

```bash
cd lsp
npm test
```

This runs `node --import tsx --test src/*.test.ts` using Node.js's built-in test runner.
