# CSS analysis explainer

A CLI that runs [`@backflip/css`](../../css/README.md) over a project and writes
a page showing **how it got its answers**, not just what they were: the parsed
rules, which partials became expansion roots and why, the compiler's authoring
tree expanding into the render forest, and a per-instance trace for any
selector.

It calls the analyzer's own code — `parseCssFile`, `buildInstanceForest`,
`compileSelector`, `matchSelectors` — and records what came back. Nothing about
the model is re-implemented for display, because a tool that explains a second
implementation explains nothing.

It imports those straight out of `css/src/`, internals and all, rather than
through `@backflip/css`. That is deliberate: an explainer is a short-lived dev
aid, and the package it explains should not carry exports that exist only to
serve one. The coupling is visible in every import line, which is the right
place for it — if these paths break, this tool is the thing that gives, not the
analyzer.

## Running it

```bash
# the bundled demo project — no other argument needed
npm --prefix dev-explainers run explain:css -- --demo

# a project with a backflip.json: templates and CSS resolved from it
npm --prefix dev-explainers run explain:css -- --project ../my-site

# or point at the pieces directly
npm --prefix dev-explainers run explain:css -- --templates ./templates --css ./styles.css -o trace.html
```

| Flag | |
|---|---|
| `--demo` | run against `demo/`, which exercises every expansion rule |
| `--project <dir>` | a directory with a `backflip.json`; templates and CSS resolved from it |
| `--templates <dir>` | template directory (overrides `--project`) |
| `--css <file>` | stylesheet; repeatable (overrides `--project`) |
| `-o, --out <file>` | output path (default `css-explain.html`) |
| `--serve` | serve on localhost; every reload re-runs the analysis |
| `--port <n>` | port for `--serve` (default 4000) |
| `--fragment` | title + style + markup with no document wrapper, for embedding |
| `--no-html` | print the results only; write no page |
| `-q, --quiet` | write the page only; print no results |

## What it prints

A one-shot run prints its results to the terminal as well as writing the page:
which partials became roots and why, then each matched element with its
selectors and `matchType hits/total`.

```
ROOTS
  article   10×    entry point — nothing calls it
  card      6×     reached from 2 call sites

MATCHES
  div.card       components.html card:1      .card                  definite    2/2
                                             .card:has(.label)      definite    2/2
                                             .stack>:nth-child(2)   conditional 1/2
  li.tag         components.html tag-list:7  .tag:first-child       conditional 1/3
                                             .tag+.tag              conditional 2/3
```

## What the page shows

Four tabs, in pipeline order, with an inspector rail that fills with whatever
you last clicked.

1. **Parse & roots** — every parsed selector with its hit count, and every
   partial with the reason it was or was not an expansion root, plus its call
   sites.
2. **Expansion** — the authoring tree with every node kind, containers included.
   It is one tree *per partial*, each headed by its definition: `b-name` in the
   gutter for a named partial, `ce-partial` where the call site renders the tag.
   Those two head rows are styled apart from the splice rules (`part`, `slot`,
   `for`, `if`), because they are boundaries rather than rules applied within
   one. Each node carries the expansion rule that applies to it and how many
   instances it produced. A `b-part` shows `0×` and the partial it splices,
   because it renders no element of its own — and so does a definition row: for
   a `b-name` the instances are counted on its own tag, the element just below;
   for a `ce-partial` they are counted on the call.
3. **Forest** — the render trees, *one per expansion root*, each under a header
   giving the root's file and partial name, why it was a root, and how big the
   tree is. The file is there because the name alone does not locate anything —
   `blog/index.html · page` and `shop/index.html · page` are two entry points. The trees are sealed off from
   each other — `getParent` stops at a top and `getSiblings` returns only the
   tops of the same tree — so no combinator crosses a boundary: the last element
   of one tree is not a sibling of the first element of the next, however
   adjacent they look. Filtering hides a tree's header along with its rows, and
   the ordinal stays absolute, so `tree 2 of 3` still reads true. The gutter
   stamps each instance's origin (`partial`, `slot`, `for`, `if`), so reading
   down a tree tells you why each node is where it is.

   The aggregation that follows deliberately runs the other way: matches are
   keyed by *source element*, so a partial used by two entry points folds into
   one result, and `definite` means "in every rendering, across every tree".
4. **Trace** — pick a selector and it decomposes into compound steps, run
   rightmost-first: `.card-title` → 2 instances, `.featured .card-title` → 1.
   Where the count drops is the constraint doing the work. Below that, per
   element, `hits/total → matchType` with a dot per instance.

The page uses system fonts only and inlines everything, so it has no network
dependency and works offline. It is theme-aware and keyboard-navigable.

## Serving it while you edit

`--serve` runs it on localhost instead of writing a file. Every reload reads the
templates and stylesheets off disk again and re-runs the whole pipeline, so the
page always reflects the files as they are now — there is no cache and no
watcher, a reload *is* the rebuild.

```bash
npm --prefix dev-explainers run explain:css -- --project ../my-site --serve
```

The page remembers which tab you were on and which selector you were tracing
across reloads (by selector *text*, so it survives a CSS edit), and whether you
had the diagnostics open. Only a setup with nothing to analyse at all is an
error, and that one is reported at startup rather than in the browser.

`--serve` binds localhost and reads whatever path you point it at. It is a local
dev tool, not something to expose.

## Compile diagnostics

Compile errors are reported, not fatal — a project mid-edit still analyses as
far as it can. They collect in a band under the header, folded shut, showing
only how many there are: on a real project the list is longer than the page, and
the count is the part worth seeing on every reload. Open it and it scrolls
within a fixed height, so it never takes the page over. The terminal gets the
first 20 and a count of the rest.

## Asset directories

Templates are compiled under the project's asset configuration, read from its
`backflip.json` — the `assets` entries, with their own prefixes, as a build
would use them. `--project` takes it from the directory you name;
`--templates` finds the nearest `backflip.json` at or above the directory you
point at, since a hand-pointed template directory still belongs to a project.

This matters more than it sounds. Given no asset directories, the compiler drops
every `src~`, `href~` and `srcset~` attribute it meets and reports each one, so
a run without the configuration both buries the page in diagnostics and matches
selectors against elements that have quietly lost their attributes — `img[src]`
stops matching, and nothing on the page says why.

So the header states what was configured, next to the budget chips:

| | |
|---|---|
| `assets @images @fonts` | compiled against those directories |
| `no asset dirs in backflip.json — src~ will not compile` | the config declares none |
| `no backflip.json found — src~ will not compile` | `--templates` outside any project |

The same line leads the terminal output and the `--serve` startup banner.

## The demo project

`demo/` is a small project built to exercise every expansion rule at once — a
carrying tag, an unwrapped call, a forwarded slot, a `b-for`, both arms of a
`b-if`, and a custom element. Its expected numbers are asserted in
`collect.test.ts`, so they double as a readable summary of the model:

| | |
|---|---|
| `.card` | `definite 2/2` — matches every time the card renders |
| `.featured .card-title` | `conditional 1/2` — only one of the two call sites is under `.featured` |
| `.tag:first-child` | `conditional 1/3` — first of three modelled loop iterations |
| `.card:has(.label)` | `definite 2/2` — `:has()` reaching into slot content |
| `.notice` | `conditional` — both `b-if` arms are modelled as present |
| `my-chip[data-role="chip"]` | `definite` — a definition attribute on the merged call tag |

## Files

| File | Purpose |
|------|---------|
| `cli.ts` | Argument parsing, the one-shot run, and the `--serve` server |
| `project.ts` | Resolves the arguments to templates, stylesheets and asset config, and compiles |
| `collect.ts` | Drives the analyzer and records each stage as a JSON payload |
| `page.ts` | Renders that payload as a self-contained HTML page |
| `summary.ts` | Renders it as text for a terminal |
| `demo/` | The project `--demo` runs, and the test fixture |

The only seam the analyzer keeps for tooling is `compileSelector` in
`css/src/selector-match.ts`, exported from that module (not from the package
index). Building the adapter here instead would mean duplicating the traversal
this tool exists to explain.

## Testing

```bash
npm run build            # from the repo root: @backflip/html resolves to dist/
npm --prefix dev-explainers test
```

It also asserts that the forest is split into one tree per root, that a tree
whose root renders no element leaves the rest unattributed rather than
mislabelled, and that two entry points' trees stay apart.

The suite asserts the demo's expansion counts and match types, that the page
carries its payload and renders in jsdom without the inline script throwing,
that compile diagnostics reach both outputs and stay folded shut on the page,
and that a project's asset directories are read out of its `backflip.json` and
compiled with — including the failure they prevent, where the dropped attribute
takes its selector match with it.
