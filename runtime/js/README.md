# JavaScript Runtime

Renders compiled template trees into HTML. Takes an `RootRNode` tree (produced by importing a generated JS module) plus a data context object, and walks the tree to produce output.

See [`docs/runtime-js.md`](../../docs/runtime-js.md) for the full API reference, usage examples, and type signatures.

## API

- `renderRoot(node, ctx, slots?, stores?)` — returns the complete HTML as a single string. Defined as the collected chunks of `streamRenderRoot`, so it shares its auto-include behavior below.
- `streamRenderRoot(node, ctx, slots?, stores?)` — returns a `Generator<string>` yielding HTML chunks incrementally. A page collector gathers the scripts and shipped stores of every reactive custom-element partial that actually rendered, and the auto-include block it builds goes before the first `</body>` if present, otherwise at the end. To do this while streaming it withholds only the trailing `</body>…` tail and flushes the block once the page is fully walked. Batch and streaming output are byte-identical. See [docs/runtime-js.md](../../docs/runtime-js.md#dom-patch-script-auto-include).
- `stores` holds store data by name; each rendered partial gets a `{ data }` object for every store it declares. See [docs/data-stores.md](../../docs/data-stores.md).
- `execFn(rfn, ctx)` — evaluates a compiled expression against a context. Rendering uses it, and so do dom-patch modules to compute a patched value.
- `activeBranchIndex(ifNode, ctx)` — the index of the branch an `if` node renders, or `-1` when none does. Rendering uses it, and so do dom-patch modules that swap a branch client-side.

## Node types handled

- **raw** — passed through as-is
- **comment** — emitted verbatim as `<!--text-->`
- **print** — evaluates expression, HTML-escapes the result via `escapeHtml()`, and inserts it
- **for** — iterates over a collection (checked via `Symbol.iterator`), rendering children once per item with an augmented context
- **if** — evaluates branches in order, renders the first truthy one
- **partial-ref** — evaluates bindings in the caller's context, renders the referenced partial with a child context built from those bindings alone (the caller's context is not inherited) and a slot map
- **slot** — renders injected content in the caller's original context
- **attr-bind** — dynamically sets an HTML attribute; boolean attributes are present/absent based on truthiness

## Testing

```bash
deno task test
```

`render_test.ts` covers the JS runtime.
