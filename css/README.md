# CSS Analyzer

`@backflip/css` analyzes CSS rules against BackflipHTML templates. It matches selectors to elements while accounting for partials, conditional rendering (`b-if`/`b-for`), slots, and dynamic attributes (`b-bind:class`, etc.).

This is a separate Node.js package used by the [LSP server](../lsp/README.md) to provide CSS hover info and selector-to-element matching in the editor.

## How it works

The `analyzeCss()` function takes CSS content, template sources, partial metadata, and the **compiled trees** for those same templates (`Map<relative path, CompiledFile>`, straight from the compiler's `compileDirectory` / `compileFiles`), then runs a 6-step pipeline:

1. **Parse CSS** — parses rules and media conditions using css-tree
2. **Parse templates** — parses HTML files with parse5, annotating Backflip directives
3. **Build usage graph** — maps partial definitions, usages, and slot injections across files
4. **Compute context spines** — calculates ancestor chains so selectors can match elements inside partials against their actual DOM context
5. **Collect match roots** — one root per compiled partial, plus one per `b-part` slot (the slot's own content, which renders somewhere else)
6. **Match selectors** — matches CSS selectors to elements using css-select with a custom adapter, computing specificity and match type

Matching runs on the compiler's `TNode` trees: a match is reported as the `ElementTNode` (or custom-element call) the compiler produced, so element identity and source locations come from the compiler rather than a second parse. Steps 2–4 still work on parse5 — the usage graph and spines are DOM-side, and the two meet at source offsets, which are file-relative on both sides.

Two consequences worth knowing:

- **Pass unflattened trees.** `flattenStatics` collapses a fully static element into a raw HTML string; a selector cannot match a string. The codegen path flattens, the CSS path must not.
- **Only compiled markup is analysed.** Content the compiler rejects or ignores — most commonly a top-level element with no `b-name` — has no tree, so it has no matches either.

## Match types

Each match is classified as one of:

- **definite** — the selector always matches this element
- **conditional** — the selector matches only in some `b-if`/`b-else-if` branches
- **dynamic** — the selector matches only if a `b-bind:class` or `b-bind:id` expression evaluates to a matching value

## Selector support

Matching runs against a *grafted* tree: a partial's own subtree hung off a single-child chain of spine ancestors (`graftOntoSpine`). So sibling and position information is only accurate **within** one source subtree — across a partial or slot boundary the chain has exactly one child per level, and a `b-part` usage stays an unexpanded leaf in the caller's tree.

The tree is the *authoring* view, as written: containers that render no tag of their own (`b-if` branches, `b-for` bodies, `b-unwrap`) are transparent, `b-part` slot content hangs under the tag carrying the call, and a custom-element call site is one element whose children are its slot content. Directive attributes (`b-if`, `b-part`, `:class`, …) are not attributes here, so `[b-part]` matches nothing; the *name* of a `:class` / `b-bind:class` binding is still known, and drives the `dynamic` match type below.

Works:

- Descendant and child combinators, in both directions across partial and slot boundaries — every partial is matched against its own upward spine, so `.wrap span` finds a `span` inside a partial used under `.wrap`
- `+` and `~` between elements in the same source subtree

Does not work:

- `+` and `~` across a partial or slot boundary — no match, e.g. `.hd + .body` where `.body` is slot content injected right after `.hd`
- `:has()` reaching into a partial — spines expand upward only, so `.wrap:has(.t)` misses a `.t` that lives inside a partial used under `.wrap`. `.wrap:has(*)` does match, via the tag carrying the `b-part`
- Structural pseudos *across* a boundary, which match wrongly rather than not at all: a partial's subtree is grafted as the only child of its innermost spine ancestor. Given `<div class="wrap"><p class="lead"></p><div b-part="card"></div></div>`, the card's own root matches `.wrap > :first-child` and `.wrap > :only-child` as `definite`. Within one source subtree they are accurate — the same `.wrap > :first-child` also matches `p.lead`, and `.wrap > :nth-child(2)` matches the `b-part` tag
- A class on the tag that *carries* a `b-part` is missing from the spine of the partial it calls, so `.wrap .item` misses an `.item` inside `card` when the call is `<div class="wrap" b-part="#card">` (it matches when `.wrap` is a plain parent instead)
- `b-for` repetition — only one element is modeled, so `.item:first-child` reports `definite` and `.item + .item` reports nothing

## Key files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main `analyzeCss()` entry point and pipeline orchestrator |
| `src/parse-css.ts` | CSS parsing, handles `@media` rules |
| `src/parse-dom.ts` | Template parsing and directive annotation |
| `src/usage-graph.ts` | Partial definition/usage graph construction |
| `src/context-spines.ts` | Ancestor chain computation for partials and slots |
| `src/tnode-view.ts` | Element/attribute view over the compiler's TNode tree |
| `src/selector-match.ts` | CSS selector matching with custom css-select adapter |
| `src/types.ts` | Type definitions |
| `src/test-helpers.ts` | Test-only: compiles template sources and runs `analyzeCss` over them |

## Dependencies

- **css-tree** — CSS parsing and AST
- **css-select** — CSS selector compilation and matching
- **css-what** — CSS selector parsing
- **parse5** — HTML parsing (usage graph and context spines only)
- **specificity** — CSS specificity calculation
- **@backflip/html** — compiler types (types only at runtime; the test helpers also call `compileFiles`)

## Setup

```bash
cd css
npm install
```

## Testing

```bash
npm run build   # from the repo root: the tests compile templates with the built dist
cd css
npm test
```

This runs `node --import tsx --test src/**/*.test.ts test/**/*.test.ts`.

Test files cover each pipeline step individually plus end-to-end integration tests in `test/integration.test.ts` with fixtures in `test/fixtures/`.
