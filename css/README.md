# CSS Analyzer

`@backflip/css` analyzes CSS rules against BackflipHTML templates. It matches selectors to elements while accounting for partials, slots, conditional rendering (`b-if`/`b-for`), and dynamic attributes (`b-bind:class`, etc.).

This is a separate Node.js package used by the [LSP server](../lsp/README.md) to provide CSS hover info and selector-to-element matching in the editor.

## How it works

`analyzeCss()` takes a list of stylesheets — `{ path, content }` each — plus the **compiled trees** for a template directory (`Map<relative path, CompiledFile>`, straight from the compiler's `compileDirectory` / `compileFiles`) and runs four steps:

1. **Parse CSS** — parses rules and media conditions using `@eslint/css-tree`, one stylesheet at a time
2. **Build the instance forest** — expands the compiled trees into the tree the runtime would render
3. **Match** — strips the pseudos a template cannot answer, then runs every selector against every instance with css-select and a custom adapter, reporting any selector it cannot read
4. **Aggregate** — folds the instances of each source element back into one result, with specificity and a match type

The package parses no HTML of its own. Everything it knows comes from the compiler's `TNode` trees, so a match is reported as the `ElementTNode` (or custom-element call) the compiler produced, and element identity and source locations come from the compiler.

Two consequences worth knowing:

- **Pass unflattened trees.** `flattenStatics` collapses a fully static element into a raw HTML string; a selector cannot match a string. The codegen path flattens, the CSS path must not.
- **Only compiled markup is analysed.** Content the compiler rejects or ignores — most commonly a top-level element with no `b-name` — has no tree, so it has no matches either, and it is not an ancestor of anything.
- **One stylesheet at a time.** Each file is parsed on its own, so `CssRule.sourceFile` and `sourceLine` address a real position in a real file, and a syntax error in one stylesheet cannot swallow the start of the next. Do not concatenate before calling.

### Unparseable CSS

css-tree never throws on malformed CSS: it skips to a recovery point and returns
fewer rules. A single stray bracket can therefore discard every rule after it,
silently.

`CssAnalysisResult.failures` reports that. Each `AnalysisFailure` carries the
file, the position where parsing broke, the parser's own message, and the extent
of the text that was dropped — enough for the LSP to underline *what was lost*,
not just point at where the parse broke. Unreadable selectors come through the
same channel, under a different `reason`; see below.

One malformed construct can raise several css-tree errors covering overlapping
text. Those are merged into one failure, keeping the first message (which names
the cause) and widening the region to everything dropped. Merging uses inclusive
bounds, because css-tree reports some errors with no fallback node at all — there
is nothing it identified as discarded — and those are recorded as an empty region
at the error itself.

Failures are never fatal. Rules that parsed before the failure still match, other
stylesheets are unaffected, and a stylesheet that fails on line 1 still returns
its failure alongside an empty rule list.

Two shapes of `stylesheet-parse` failure come from css-tree:

- a **syntax error at the top level**, whose lost region runs to the end of the file
- a **malformed prelude** — a bad at-rule condition or an empty pseudo — whose
  lost region is contained, so parsing recovers and later rules still match.

### Unreadable selectors

A selector can be valid CSS and still be one the matcher cannot read: a pseudo
nobody has categorized, a supported name with an argument css-select refuses
(`:nth-child(2 of svg|circle)`), a top-level `&` with no parent to resolve
against. Most selectors that used to land here no longer do — the pseudos
css-select chokes on come off before compiling, see
[Pseudo relaxation](#pseudo-relaxation) — and what is left is treated as an
error in the authored CSS rather than guessed at.

Those come through the same `failures` channel, as `reason: 'selector-parse'`,
with the lost region set to the selector's own extent so the LSP underlines the
selector and nothing else. Only that selector is affected: the rest of its rule
list, its rule's declarations, and every other rule in the file are analyzed
exactly as before.

`CssRule.selectorLocs` is what makes that possible — one source extent per entry
of `CssRule.selectors`, parallel to it. For a nested rule the extent is the text
as authored (`&.featured`), not the resolved selector, because the extent is
what an editor underlines.

### Selector text

`CssRule.selectors` carries each selector **as authored**, sliced from the source
rather than regenerated from the AST. Two things are patched into that slice,
both located by AST node so neither is found by searching the text: comments are
removed, and `&` is replaced by the enclosing rule (see below).

This is not cosmetic. `csstree.generate` normalizes whitespace, and one of those
normalizations produces text css-select cannot read: `:nth-child(2 of .x)` comes
back as `:nth-child(2 of.x)`. That is legal CSS — `.` cannot continue an
identifier — but css-select matches the `of` clause with a regex demanding
whitespace on both sides, so it threw, `compileSelector` swallowed the throw, and
the rule matched nothing at all. The same round-trip also dropped the author's
spacing around combinators (`.a + .b` became `.a+.b`), which is what the LSP
shows on hover.

A comment is not a separator in CSS, so it is replaced with nothing rather than
with a space: `.a/* x */.b` is the compound `.a.b`. Whitespace that surrounded a
comment is authored text and stays, so `.a /* x */ .b` becomes `.a  .b` — two
spaces, which any CSS engine reads as the one descendant combinator it is.

`@media` conditions are still generated rather than sliced; they never reach
css-select.

### Nested rules

CSS Nesting is parsed and **resolved against the enclosing rule**, so every
`CssRule.selectorText` that leaves the parser is absolute and can be matched on
its own. `.card { .direct { … } }` yields `.card` and `.card .direct`.

A nested rule is a `Rule` inside its parent's `Block`, so `parseCssFile` keeps a
stack of resolved parent selectors and pushes/pops it exactly as it already does
for `@media` — the two combine, so a rule nested inside `@media` inside a rule
carries both. Resolution is one level deep at each step, because the parent on
the stack is already absolute.

| Written | Resolved |
|---|---|
| `.card { .direct { … } }` | `.card .direct` |
| `.card { & .ok { … } }` | `.card .ok` |
| `.card { &.featured { … } }` | `.card.featured` |
| `.card { .outer & { … } }` | `.outer .card` |
| `.a, .b { .c { … } }` | `:is(.a,.b) .c` |

A multi-selector parent becomes `:is(…)` rather than one rule per parent. That
keeps one authored rule as one `CssRule` — so hover and match counts reflect what
was written — and it is what the spec scores: `&` takes the specificity of the
*most specific* parent selector, which `:is()` does and per-parent expansion does
not. A single parent needs no wrapper, so the common case stays readable.

Two details worth knowing:

- **Substitution is located by AST node, not by string search.** `&` is a
  `NestingSelector` node, so an ampersand that is only text — `[data-q="a&b"]` —
  is left intact, and the authored text on either side of it is untouched.
- **A top-level `&` has no parent** and is left as written. It will not compile in
  css-select, so it is reported as an unreadable selector at match time.

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

### Pseudo relaxation

Backflip analyzes templates. There is no browser, no user, no session — whether an element is hovered, focused, visited or checked is not a property of the template but a state the page passes through over its life. A rule mentioning one of those used to match **nothing at all**.

So the pseudos Backflip cannot answer are **stripped from the selector before matching**, and the rule is reported against the element the remainder targets. `relaxSelector()` does the rewriting; `pseudo-categories.ts` is the list that decides what comes off, and `MatchedRule.strippedPseudos` reports what did, with a category for each.

```
.card:hover                  →  .card                 :hover      (user-action)
a:visited                    →  a                     :visited    (location)
.note::before                →  .note                 ::before    (tree-abiding)
.toggle:checked + .label     →  .toggle + .label      :checked    (input)
.a:not(:focus)               →  .a                    :focus :not
.wrap > ::selection          →  .wrap > *             ::selection (highlight)
```

**Relaxation widens matching, on purpose.** `a:hover` and `a:visited` both report as targeting every `a`; a rule that relaxes away entirely, like a bare `::selection`, reports against every element, because it really does apply everywhere. `strippedPseudos` is what lets a consumer say so rather than enumerate the tree.

**The reported selector and its specificity stay as authored.** `MatchedRule.selector` is `.card:hover`, not `.card`, and its specificity is `[0, 2, 0]` — `:hover` counts as a class and `::before` as an element. Relaxation is confined to what gets handed to `css-select`.

**`matchType` is a separate axis.** `.card::before` genuinely applies whenever `.card` renders, so it is `definite`; `.card:hover` targets the card definitely too, and it is only the *state* that is open. `matchType` describes render-time knowability; `strippedPseudos` describes what could not be answered at all.

What gets stripped is a statement about what Backflip can *know*, not about what `css-select` can compile:

- `:checked`, `:disabled`, `:enabled`, `:required` and `:optional` come off **even though `css-select` supports them** — it resolves them to attribute presence, which is the template's initial markup rather than the element's state. `input:checked + label` is the canonical toggle and would otherwise report nothing.
- `:lang()` stays, because it resolves against the markup's own `lang` attributes, which the template does settle.

What stays native, because the render tree answers it: everything tree-structural (`:first-child`, `:nth-child()` including `:nth-child(2 of S)`, `:root`, `:empty`, `:only-of-type`, …), the functional pseudos (`:is`, `:not`, `:where`, `:has`), `:scope`, `:lang()`, `:any-link` and `:link`, and `css-select`'s jQuery-flavored aliases (`:parent`, `:header`, `:checkbox`, …).

An unrecognized `-moz-` / `-webkit-` / `-ms-` / `-o-` name is stripped as `non-standard`, since enumerating vendor prefixes is a losing game. Any *other* pseudo the list has never heard of is left alone for `css-select` to judge — and if it refuses, the selector is reported as one Backflip cannot parse (see [Unreadable selectors](#unreadable-selectors)) rather than stripped on spec. CSS grows a pseudo rarely; guessing at what an uncategorized one means, on every selector that carries one, is the worse trade. Adding it to `pseudo-categories.ts` is the fix.

What the model does not capture:

- **`b-for` past three iterations.** A loop body is modelled as `FOR_REPS = 3` instances, enough for `:first-child`, `:last-child`, `+`, `~` and a middle `:nth-child(2)`. `:nth-child(9)` is not modelled — any fixed count would lie about some selector.
- **Mutually exclusive `b-if` branches.** Every branch is modelled as present, so two elements in different branches look like siblings. `.a + .b` across them is a false positive — always reported `conditional`, never `definite`.
- **`<template>` content.** A browser keeps a template's children out of the DOM tree; here they are ordinary instances. `:has()` does not look inside one — css-select skips a `template` tag's children whenever it walks down — but a descendant selector, which matches upwards from the element, still reaches in: `.wrap .t` is reported where a browser reports nothing.
- **Dynamic class and id values.** A `:class="expr"` is known by name only; `.btn-primary` is not predicted from the expression. The element is reported `dynamic` for any class/id selector instead.
- **Runtime data.** Which `b-if` branch is taken, how many times a `b-for` runs, and what a binding evaluates to are all unknown at analysis time. That is what `conditional` and `dynamic` exist to say.

## Key files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main `analyzeCss()` entry point and pipeline orchestrator |
| `src/parse-css.ts` | CSS parsing, handles `@media` rules, reports parse failures |
| `src/instance-tree.ts` | The render tree: expansion rules, environments, roots, budgets |
| `src/selector-match.ts` | The css-select adapter over instances, and match aggregation |
| `src/relax-selector.ts` | Strips the pseudos Backflip cannot answer, so the remainder can be matched |
| `src/pseudo-categories.ts` | Which pseudos those are, and what kind of thing each one is |
| `src/tnode-view.ts` | Tag name and attribute lookup over the compiler's TNodes |
| `src/types.ts` | Type definitions |
| `src/test-helpers.ts` | Test-only: compiles template sources and runs `analyzeCss` over them |

To see the pipeline run on a real project — the parsed rules, which partials
became roots and why, the authoring tree expanding into the render forest, and a
per-instance trace for any selector — use
[`dev-explainers/css-analysis`](../dev-explainers/css-analysis/README.md).

## Dependencies

- **@eslint/css-tree** — CSS parsing and AST (ESLint's fork of `css-tree`, kept current with the CSS specs and shipping its own types)
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
