# CSS Analyzer

`@backflip/css` analyzes CSS rules against BackflipHTML templates. It matches selectors to elements while accounting for partials, slots, conditional rendering (`b-if`/`b-for`), and dynamic attributes (`b-bind:class`, etc.).

This is a separate Node.js package used by the [LSP server](../lsp/README.md) to provide CSS hover info and selector-to-element matching in the editor.

## How it works

`analyzeCss()` takes CSS content plus the **compiled trees** for a template directory (`Map<relative path, CompiledFile>`, straight from the compiler's `compileDirectory` / `compileFiles`) and runs four steps:

1. **Parse CSS** — parses rules and media conditions using css-tree
2. **Build the instance forest** — expands the compiled trees into the tree the runtime would render
3. **Match** — runs every selector against every instance with css-select and a custom adapter
4. **Aggregate** — folds the instances of each source element back into one result, with specificity and a match type

The package parses no HTML of its own. Everything it knows comes from the compiler's `TNode` trees, so a match is reported as the `ElementTNode` (or custom-element call) the compiler produced, and element identity and source locations come from the compiler.

Two consequences worth knowing:

- **Pass unflattened trees.** `flattenStatics` collapses a fully static element into a raw HTML string; a selector cannot match a string. The codegen path flattens, the CSS path must not.
- **Only compiled markup is analysed.** Content the compiler rejects or ignores — most commonly a top-level element with no `b-name` — has no tree, so it has no matches either, and it is not an ancestor of anything.

### The instance model

The compiler's tree is the *authoring* view: a `b-part` call is a leaf in the caller's tree, slot content hangs where it was written rather than where it renders, and one `b-for` body stands in for every iteration. A browser matches against the *rendered* view instead, so that is what this package builds.

A node in that view is an **instance**: a `(TNode, environment)` pair. One `ElementTNode` inside a partial used three times is three instances, each with its own parent chain. `src/instance-tree.ts` expands them lazily — `getParent` / `getChildren` / `getSiblings` cross partial, slot and custom-element boundaries the same way `runtime/js/render.ts` does, and css-select never needs the whole forest materialized to answer a query.

One expansion rule per TNode variant, each mirroring a `streamRender*` case:

| TNode | Instances |
|---|---|
| `element` | one; children expand under the same environment |
| `partial-ref` / `b-part` | none of its own — the target's body is spliced in under a fresh environment binding the call's fills. The tag carrying the call, when there is one, is already the enclosing element |
| `partial-ref` / `custom-element` | one merged tag: call-site attrs then definition attrs, children being the target's body |
| `partial-ref` / `custom-element`, unresolved | one tag with the call-site attrs, children being the default slot in the caller's environment |
| `slot` | the fill spliced in under the environment it was *written* in — which is what makes slot forwarding work at any depth |
| `for` | the body repeated `FOR_REPS` (3) times |
| `if` | every branch spliced in, each branch's top instances marked conditional |
| `raw` / `comment` / `print` / `attr-bind` | none |

Entry points are the partials nothing calls; everything else is reached through them. A partial left with no instances after that — one only reachable through a reference cycle, or one nothing uses — is expanded standalone against an empty environment.

Two budgets keep a broken or pathological tree from running away, since the LSP analyses half-written templates: `MAX_DEPTH` (20) element levels, and `MAX_INSTANCES` (50 000) instances per run. On exhaustion expansion stops and matching finishes on what exists; nothing throws.

## Match types

Each match is classified as one of:

- **definite** — the selector matched in *every* instance of the element, and none of them was inside a `b-if` branch
- **conditional** — it matched in some instances but not all, or only under a branch that may not be taken. So: one use of a partial but not another, one position of a `b-for`, or one arm of a `b-if`
- **dynamic** — the selector keys off a class or id the element binds at runtime (`b-bind:class` / `:class`), so whether it matches is not knowable here. Checked first, ahead of the other two

`definite` really means "in every context". A partial used in two places, only one of which is under `.wrap`, reports `.wrap .item` as `conditional`.

## Selector support

Matching runs against the render tree, so combinators, structural pseudos and `:has()` all work across partial, slot and custom-element boundaries — `.hd + .body` finds slot content injected after `.hd`, `.wrap:has(.t)` sees a `.t` inside a partial used under `.wrap`, and `.wrap > :nth-child(2)` counts the children that actually render there.

The tree is the compiler's, so directive attributes (`b-if`, `b-part`, `:class`, …) are not attributes: `[b-part]` matches nothing. The *name* of a `:class` / `b-bind:class` binding is still known, and drives the `dynamic` match type.

What the model does not capture:

- **`b-for` past three iterations.** A loop body is modelled as `FOR_REPS = 3` instances, enough for `:first-child`, `:last-child`, `+`, `~` and a middle `:nth-child(2)`. `:nth-child(9)` is not modelled — any fixed count would lie about some selector.
- **Mutually exclusive `b-if` branches.** Every branch is modelled as present, so two elements in different branches look like siblings. `.a + .b` across them is a false positive — always reported `conditional`, never `definite`.
- **`:contains()`.** Template text is not modelled (`getText` returns `''`), so it never matches.
- **`<template>` content.** A browser keeps a template's children out of the DOM tree; here they are ordinary instances. `:has()` does not look inside one — css-select skips a `template` tag's children whenever it walks down — but a descendant selector, which matches upwards from the element, still reaches in: `.wrap .t` is reported where a browser reports nothing.
- **Dynamic class and id values.** A `:class="expr"` is known by name only; `.btn-primary` is not predicted from the expression. The element is reported `dynamic` for any class/id selector instead.
- **Runtime data.** Which `b-if` branch is taken, how many times a `b-for` runs, and what a binding evaluates to are all unknown at analysis time. That is what `conditional` and `dynamic` exist to say.

## Key files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main `analyzeCss()` entry point and pipeline orchestrator |
| `src/parse-css.ts` | CSS parsing, handles `@media` rules |
| `src/instance-tree.ts` | The render tree: expansion rules, environments, roots, budgets |
| `src/selector-match.ts` | The css-select adapter over instances, and match aggregation |
| `src/tnode-view.ts` | Tag name and attribute lookup over the compiler's TNodes |
| `src/types.ts` | Type definitions |
| `src/test-helpers.ts` | Test-only: compiles template sources and runs `analyzeCss` over them |

To see the pipeline run on a real project — the parsed rules, which partials
became roots and why, the authoring tree expanding into the render forest, and a
per-instance trace for any selector — use
[`dev-explainers/css-analysis`](../dev-explainers/css-analysis/README.md).

## Dependencies

- **css-tree** — CSS parsing and AST
- **css-select** — CSS selector compilation and matching
- **css-what** — CSS selector parsing
- **specificity** — CSS specificity calculation
- **@backflip/html** — compiler types, plus `resolvePartial` / `visitTNodes` for expansion (the test helpers also call `compileFiles`)

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

Test files cover each pipeline step individually plus end-to-end integration tests in `test/integration.test.ts` with fixtures in `test/fixtures/`. The integration suite renders each fixture with the real JS runtime and queries the result with jsdom, so the analyzer's answers are checked against the DOM the runtime actually produces.
