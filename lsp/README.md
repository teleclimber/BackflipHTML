# Language Server (LSP)

`@backflip/lsp` is a Language Server Protocol implementation that provides IDE features for BackflipHTML templates. It is used by the [VSCode extension](../vscode-backflip/) but can work with any LSP-compatible editor.

## Features

- **Diagnostics** — red underlines for template compilation errors, and warnings on CSS files whose syntax stopped the analyzer
- **Go to Definition** — click a `b-part` reference to jump to the `b-name` definition, or click a custom element partial tag (e.g. `<my-card>`) to jump to its definition
- **Find All References** — from a `b-name` definition, find all `b-part` usages; from an `@name/subpath` asset reference, find every use of that asset across templates and stylesheets
- **Completion** — asset directory names and file paths, `b-part` targets, custom element partial tags, and the slot names a `b-in` can fill, each offered while the value is being typed
- **Document Symbols** — lists partials in the editor outline/breadcrumbs, each spanning its whole definition so breadcrumbs track the cursor anywhere inside a partial
- **Hover (HTML)** — hover over `b-part`, `b-name`, `b-in`, `b-slot`, `b-data:` attributes, asset paths, custom element partial tags (e.g. `<my-card>`), or HTML elements to see directive info and matching CSS rules; a definition's hover lists its references as links that jump to them
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

### Indexing partial references

`src/index.ts` builds the project index that answers "where is this partial
used?" — a definition hover's reference list and the results of Find All
References both read `index.partialRefs`.

A reference is matched to a definition by file: a same-file `b-part="#name"`
(`targetFile === null`) matches a definition in the file it was written in, and
a cross-file one matches the file it names.

Hovering a definition lists those references — the first ten, then a count of
the rest — as `backflipHTML.openFileAtLocation` links that jump to the `b-part`.
Like the CSS hovers' location links, they are clickable only because the
extension's hover middleware marks hover markdown trusted for that command.

### Resolving the cursor

`src/resolve.ts` answers "what is at this position?" from the compiled tree.
`resolveAt(file, offset)`
returns everything whose span covers the offset — the element, the directive on
it, the partial it belongs to — innermost first, where innermost means the
narrowest span. `elementAt` and `targetAt` are the narrow forms.

Spans come from the compiler, so the answer does not change when two elements
share a line, when an element's open tag straddles a line break, or when the
cursor is in text content rather than on a tag: the element you are inside is
the element you get, and its ancestors follow it in the list. Spans are
half-open, so where `</span>` ends is the `<` of the next tag and belongs to
that tag alone.

Two limits are worth knowing. Content outside every partial definition never
reaches a compiled tree, so it resolves to nothing. And raw text runs carry no
location at all, so they resolve to their containing element rather than to
themselves.

Element hover (**Hover (HTML)** on a plain tag) is built on this: the element
under the cursor is looked up in the CSS analysis by the offset its open tag
starts at. The analysis only lists elements that matched at least one rule, so
an element with no rules shows no hover rather than its parent's rules.

The directive probes — `b-part`, `b-name`, `b-in`, `b-slot`, `b-data:`,
`b-attr:`, asset references — still match against the hovered line's text, and
still take the first match on that line. `resolve.ts` already reports all of
them, so moving those over is a mechanical change; it is held back only because
their tests are built on template fragments that carry no `b-name` and so
compile to no tree at all.

What *contains* the cursor's tag comes from `src/tag-context.ts` instead — see
[Completion](#completion). A `b-in` hover names its call from there, so it
resolves a call the tag is actually inside, custom element calls included.

### Completion

Four things complete: an asset path (see [Asset references](#asset-references)),
a `b-part` target, a custom element partial tag, and a slot name in `b-in`.
`src/completion.ts` tries each probe in turn and answers with the first that has
something to offer; the probes match disjoint positions, so at most one does.

Every probe reads the document's text — through `src/tag-context.ts` for the
tag-shaped questions, `src/asset-attr.ts` for the asset ones — rather than the
compiled tree. That is what lets them answer mid-keystroke: the trees are
rebuilt on save, so by the time a completion is asked for, their spans no longer
line up with what is on screen.

**`b-part`** names a partial in this file (`#name`) or one another file exports
(`path/file.html#name`). Before a `#` is typed, all three ways in are offered —
this file's names, the files that export something, and every exported partial
written out in full — because which is wanted is not yet knowable. After a `#`,
only what its left-hand side can reach: this file's partials, or the named
file's exported ones. A file item re-opens the suggest widget, so picking one
leads straight to its partials.

**A custom element tag** completes from where the cursor sits at a `<` followed
by name characters. What is offered is what a call in this file can resolve —
its own definitions plus the exported ones — which is the set
`resolveCustomElementCalls` links against, so nothing is offered that would then
fail to compile.

**`b-in`** offers the slots of the call whose body the tag sits in.
`findEnclosingCallSiteTag` finds that call by counting tags backwards from the
cursor's own tag, skipping void and self-closing ones, rather than taking the
nearest `b-part` written above: a call nested inside a call body, or a sibling
that has already closed, is not the one the tag is in. Both call forms answer —
`b-part="…"` and a custom element tag. A parent that makes no call offers
nothing, since `b-in` only routes from a direct child of a call body.

#### Matching

What is offered is decided here, by `matchRank`: a candidate matches when the
**whole typed string appears in it in one piece**, anywhere. `shell` finds
`page-shell` and `PageShell`, `hell` finds both too, and `pgsl` finds nothing.
Case is the one thing ignored. A `b-part` is matched on the half the cursor is
in: the name after a `#`, or the name *or* file before one. A tag or slot is
matched on its name.

Where the match lands is the rank rather than a condition, and `sortText`
carries it: a name the typed text opens comes before one where it opens a word
(after a separator, or at a capital), which comes before one where it only
appears mid-word. So `shell` lists `shell-box`, then `page-shell`, then
`bombshell`. Matching and ranking are one pass, because they are one question.

Every item's `filterText` is the typed text verbatim, so the client's own pass
matches all of them and drops none, and the response is marked `isIncomplete` so
the next keystroke asks again rather than re-filtering the list already in hand.
The offer is settled here.

**Why the client cannot be left to filter.** Not only because its matching is
fuzzy — it matches the word it believes is being typed against one fixed
`filterText` per item, and a partial reference is not a word. The same row has
to answer to `page-shell`, to `#page-shell` and to `layout.html#page-shell`, and
no single value matches what was typed in all three forms. Where they disagree
the row scores nothing and disappears; worse, a VS Code model that empties while
the leading word is empty — which any `-` makes it — cancels the session
outright, so the list reads "No suggestions" rather than going stale. Every
custom element name carries a `-`, so this is the common case, not an edge.

Two costs follow: one request per keystroke while a value is open, and no match
highlighting in the labels, which the client draws from its own match. What it
buys, beyond the value grammar working at all, is that the rule here is the
whole rule: a mid-word match is offered because nothing downstream can refuse
it. Nothing here depends on the user's `editor.suggest` settings.

`sortText` orders the offer: group first (this file's names, then files, then
qualified refs), then names the typed text *opens* ahead of names it merely
appears inside, then alphabetically.

Asset paths keep their own narrowing — entries whose name starts with what is
typed — and are unaffected by the above beyond re-querying per keystroke.

Items carry their own edit range for the same reason the asset ones do: it spans
the whole value, so accepting one rewrites the value rather than appending to it.

### Asset references

Two attribute forms name an asset: any attribute with the `~` suffix (`src~=`,
`:srcset~=`), and [`b-script=`](../docs/partials.md#client-script-b-script) on a
custom element partial definition, which names a module rather than setting an
attribute value and so carries no `~`. Hover, go-to-definition, find-references
and completion all decide what the cursor is on through `src/asset-attr.ts`.

Those probes read the line's text rather than the compiled tree, which is what
lets completion answer while the attribute is still being typed and the document
does not yet compile.

Every completion item carries its own edit range and filter text, spanning the
whole `@name/subpath` — back to where the ref starts, and forward past the
cursor to where it ends. Left to guess, a client falls back to the word under
the cursor, and no editor's word pattern treats a ref as one word: it would
replace a fragment and leave the rest of the ref in place, and would filter the
offered items against a word the `@` had been cut from.

`assetRefEditAtCursor` reports that extent. Since a value names one asset — and
a srcset one per candidate — the ref is the token opening the candidate the
cursor is in, which makes an empty value a ref not yet started: completion
offers every asset directory there, and writes one in at the cursor. The `@` is
part of what is being completed rather than a precondition for it, so a name
typed without one still completes and the item writes it in. Past that first
token is a srcset descriptor, which names nothing and so offers nothing.

Find-all-references on an `@name/subpath` reads the asset references collected
from the last compile — `collectAllAssetReferences`, which walks the compiled
trees and the discovered stylesheets.

A stylesheet's `url(...)` is a use of the asset too, so those are listed
alongside the template ones. They differ in two ways: their path resolves
against the asset directory holding the stylesheet rather than the template
root, and css-tree reports only where a url starts, so those locations are a
caret while template references carry the reference's full extent.

The collected set is shared with asset validation and the Asset Report panel, so
all three agree and only one pass walks the trees per compile.

### Symbol ranges

A partial's symbol spans the whole definition — opening `<` through the end of
the closing tag — while its `selectionRange` covers just the name: the
`b-name="..."` attribute, or the open tag for a custom element partial. The wide
range is what makes breadcrumbs track the cursor as it moves through a partial's
body, and what lets the extension answer "which partial is the cursor in?" for
**Preview Partial** rather than only on the definition line.

The compiler reports that extent as file offsets (`PartialMeta`), so converting
it needs the open document. Without one — or for a definition whose closing tag
was never found, which leaves no usable extent — both ranges fall back to the
name span.

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
| `src/index.ts` | Project indexing: maps partial definitions and references (collection shared with the compiler) |
| `src/resolve.ts` | Cursor position → the element/directive under it, from the compiled tree |
| `src/asset-attr.ts` | Cursor position → the asset attribute and `@name/subpath` under it, from the line's text |
| `src/tag-context.ts` | Cursor position → the tag it is in and the partial call containing that tag, from the document's text |
| `src/completion.ts` | Completion: asset paths, `b-part` targets, custom element tags, `b-in` slot names |
| `src/hover.ts` | Hover information for directives and CSS selectors |
| `src/definition.ts` | Go-to-definition for `b-part` → `b-name` |
| `src/references.ts` | Find-references for partial usage and asset references |
| `src/symbols.ts` | Document symbols: lists partials in file, with full-definition ranges |
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
