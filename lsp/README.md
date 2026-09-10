# Language Server (LSP)

`@backflip/lsp` is a Language Server Protocol implementation that provides IDE features for BackflipHTML templates. It is used by the [VSCode extension](../vscode-backflip/) but can work with any LSP-compatible editor.

## Features

- **Diagnostics** — red underlines for template compilation errors, and warnings on CSS files whose syntax stopped the analyzer
- **Go to Definition** — click a `b-part` reference to jump to the `b-name` definition, or click a custom element partial tag (e.g. `<my-card>`) to jump to its definition
- **Find All References** — from a `b-name` definition, find all `b-part` usages
- **Document Symbols** — lists partials in the editor outline/breadcrumbs
- **Hover (HTML)** — hover over `b-part`, `b-name`, `b-in`, `b-slot`, `b-data:` attributes, custom element partial tags (e.g. `<my-card>`), or HTML elements to see directive info and matching CSS rules
- **Hover (CSS)** — hover over a selector in a CSS file to see which partials contain matching elements

Both CSS hovers also name the pseudos that were stripped before matching, and what kind of thing each one is — see [Relaxed pseudos in CSS hover](#relaxed-pseudos-in-css-hover).

## How it works

The server requires a `backflip.json` in the workspace root to activate (see [`docs/configuration.md`](../docs/configuration.md)). On file open/save, it runs `compileDirectory()` on the template directory and builds a project index of partial definitions and references. CSS analysis is provided by [`@backflip/css`](../css/README.md) — CSS files are automatically discovered from configured asset directories.

### Relaxed pseudos in CSS hover

A template cannot say whether an element is hovered, focused, visited or
checked, so [`@backflip/css`](../css/README.md#pseudo-relaxation) strips those
pseudos from a selector before matching and reports the rule against the element
the remainder targets. Both CSS hovers say when that happened, so a rule listed
against an element despite its `:hover` explains itself:

- **Element → rules** adds a line under the selector: ``ignoring `:hover` (user-action)``.
  The selector on the line above is the authored text, `.card:hover`, and the
  specificity beside it is the authored one.
- **Selector → elements** adds one note for the whole rule:
  ``Matched ignoring `::before` (tree-abiding) — not answerable from a template.``

The category — `user-action`, `input`, `tree-abiding`, `highlight`, … — comes
from the analyzer. Both are carried on `MatchedRule.strippedPseudos` and reach
the "Find All Matches" and "Find All Selectors" panels through the same fields.

A pseudo the analyzer's list has never heard of is *not* relaxed: the selector
carrying it is reported as one Backflip cannot parse, and warned about on the
selector — see [CSS parse warnings](#css-parse-warnings).

Note that relaxation *widens* what a hover lists: `a:hover` and `a:visited` both
show every link, and a bare `::selection` shows every element.

### CSS parse warnings

Two things stop CSS being analyzed, and both are published as **warnings on the
stylesheet itself**.

Malformed CSS makes the parser (`@eslint/css-tree`) skip to a recovery point, so
rules after the problem are never analyzed and simply stop reporting matches. The
server underlines the entire skipped region so it is obvious which rules stopped
being analyzed, with the parser's own complaint and the line count in the message.

How much is lost depends on where the break is: a bad selector at the top level
usually discards everything after it, so expect the underline to run to the end
of the file, while a malformed prelude costs only its own rule and parsing
recovers. Where the parser raises several errors for the same damage, the regions
are merged before publishing, so the same CSS is never underlined twice.

The same channel carries the second kind: a **selector the matcher cannot
read**. That is valid CSS as far as the parser is concerned — an uncategorized
pseudo, an argument css-select refuses, a top-level `&` — so nothing is skipped
around it; only that one selector reports no matches. The warning underlines the
selector itself and says so, and its rule's other selectors keep working.

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
