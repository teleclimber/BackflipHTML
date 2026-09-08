# Language Server (LSP)

`@backflip/lsp` is a Language Server Protocol implementation that provides IDE features for BackflipHTML templates. It is used by the [VSCode extension](../vscode-backflip/) but can work with any LSP-compatible editor.

## Features

- **Diagnostics** — red underlines for template compilation errors, and warnings on CSS files whose syntax stopped the analyzer
- **Go to Definition** — click a `b-part` reference to jump to the `b-name` definition, or click a custom element partial tag (e.g. `<my-card>`) to jump to its definition
- **Find All References** — from a `b-name` definition, find all `b-part` usages
- **Document Symbols** — lists partials in the editor outline/breadcrumbs
- **Hover (HTML)** — hover over `b-part`, `b-name`, `b-in`, `b-slot`, `b-data:` attributes, custom element partial tags (e.g. `<my-card>`), or HTML elements to see directive info and matching CSS rules
- **Hover (CSS)** — hover over a selector in a CSS file to see which partials contain matching elements

## How it works

The server requires a `backflip.json` in the workspace root to activate (see [`docs/configuration.md`](../docs/configuration.md)). On file open/save, it runs `compileDirectory()` on the template directory and builds a project index of partial definitions and references. CSS analysis is provided by [`@backflip/css`](../css/README.md) — CSS files are automatically discovered from configured asset directories.

### CSS parse warnings

Malformed CSS makes css-tree skip to a recovery point, so rules after the
problem are never analyzed and simply stop reporting matches. The server
publishes those as **warnings on the stylesheet itself**, underlining the entire
skipped region so it is obvious which rules stopped being analyzed, with the
parser's own complaint and the line count in the message.

One bad character usually discards everything after it, so expect the underline
to run to the end of the file. Where css-tree raises several errors for the same
damage, the regions are merged before publishing, so the same CSS is never
underlined twice.

They are warnings rather than errors on purpose: the stylesheet still ships and
still works in a browser: what is degraded is Backflip's view of it. Nothing
about them blocks template compilation, which runs on a separate path.

Analysis runs on save (debounced), not on every keystroke, and reads stylesheets
from disk — so warnings reflect the saved file, and appear when you save either a
template or the stylesheet itself.

File changes trigger recompilation with a 300ms debounce. The server runs its own native recursive filesystem watcher (shared with the preview server, see [`lib/watch.ts`](../lib/watch.ts)) over the template root and asset directories, so edits, file renames, and directory renames/moves all recompute — including changes made outside the editor (e.g. from the terminal). The editor client's watched-file notifications are kept as a backup for environments where native `fs.watch` is unreliable. The server also watches for `backflip.json` changes to reload configuration.

## Key files

| File | Purpose |
|------|---------|
| `src/server.ts` | LSP connection setup, all request/notification handlers |
| `src/index.ts` | Project indexing: maps partial definitions and references |
| `src/hover.ts` | Hover information for directives and CSS selectors |
| `src/definition.ts` | Go-to-definition for `b-part` → `b-name` |
| `src/references.ts` | Find-references for partial usage |
| `src/symbols.ts` | Document symbols: lists partials in file |
| `src/diagnostics.ts` | Compilation error and CSS parse failure → LSP diagnostic conversion |
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

This does **not** update the server VS Code runs. The extension carries its own
copy, so changes here reach the editor only after `npm run build:extension` at
the repo root and a reinstall — see
[`vscode-backflip/README.md`](../vscode-backflip/README.md).

## Testing

```bash
cd lsp
npm test
```

This runs `node --import tsx --test src/*.test.ts` using Node.js's built-in test runner.
