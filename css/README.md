# CSS Analyzer

`@backflip/css` analyzes CSS rules against BackflipHTML templates. It matches selectors to elements while accounting for partials, conditional rendering (`b-if`/`b-for`), slots, and dynamic attributes (`b-bind:class`, etc.).

This is a separate Node.js package used by the [LSP server](../lsp/README.md) to provide CSS hover info and selector-to-element matching in the editor.

## How it works

The `analyzeCss()` function takes CSS content, template files, and partial metadata, then runs a 6-step pipeline:

1. **Parse CSS** — parses rules and media conditions using css-tree
2. **Parse templates** — parses HTML files with parse5, annotating Backflip directives
3. **Build usage graph** — maps partial definitions, usages, and slot injections across files
4. **Compute context spines** — calculates ancestor chains so selectors can match elements inside partials against their actual DOM context
5. **Build match trees** — creates unified node trees for elements and slots
6. **Match selectors** — matches CSS selectors to elements using css-select with a custom adapter, computing specificity and match type

## Match types

Each match is classified as one of:

- **definite** — the selector always matches this element
- **conditional** — the selector matches only in some `b-if`/`b-else-if` branches
- **dynamic** — the selector matches only if a `b-bind:class` or `b-bind:id` expression evaluates to a matching value

## Selector support

Matching runs against a *grafted* tree: a partial's own subtree hung off a single-child chain of spine ancestors (`graftOntoSpine`). So sibling and position information is only accurate **within** one source subtree — across a partial or slot boundary the chain has exactly one child per level, and a `b-part` usage stays an unexpanded leaf in the caller's tree.

Works:

- Descendant and child combinators, in both directions across partial and slot boundaries — every partial is matched against its own upward spine, so `.wrap span` finds a `span` inside a partial used under `.wrap`
- `+` and `~` between elements in the same source subtree

Does not work:

- `+` and `~` across a partial or slot boundary — no match, e.g. `.hd + .body` where `.body` is slot content injected right after `.hd`
- `:has()` reaching into a partial — spines expand upward only, so `.wrap:has(.t)` misses a `.t` that lives inside a partial used under `.wrap`. `:has(*)` does match, but against the `b-part` placeholder, which doesn't survive to runtime
- Structural pseudos at a boundary, which match *wrongly* rather than not at all. Given `<div class="wrap"><p class="lead"></p><div b-part="card"></div></div>`, `.wrap > :first-child` and `.wrap > :only-child` match the card as `definite`, while the correct `.wrap > :nth-child(2)` does not
- `b-for` repetition — only one element is modeled, so `.item:first-child` reports `definite` and `.item + .item` reports nothing

## Key files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main `analyzeCss()` entry point and pipeline orchestrator |
| `src/parse-css.ts` | CSS parsing, handles `@media` rules |
| `src/parse-dom.ts` | Template parsing and directive annotation |
| `src/usage-graph.ts` | Partial definition/usage graph construction |
| `src/context-spines.ts` | Ancestor chain computation for partials and slots |
| `src/selector-match.ts` | CSS selector matching with custom css-select adapter |
| `src/types.ts` | Type definitions |

## Dependencies

- **css-tree** — CSS parsing and AST
- **css-select** — CSS selector compilation and matching
- **css-what** — CSS selector parsing
- **parse5** — HTML parsing
- **specificity** — CSS specificity calculation

## Setup

```bash
cd css
npm install
```

## Testing

```bash
cd css
npm test
```

This runs `node --import tsx --test src/**/*.test.ts test/**/*.test.ts`.

Test files cover each pipeline step individually plus end-to-end integration tests in `test/integration.test.ts` with fixtures in `test/fixtures/`.
