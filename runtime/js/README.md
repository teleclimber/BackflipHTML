# JavaScript Runtime

Renders compiled template trees into HTML. Takes an `RootRNode` tree (produced by importing a generated JS module) plus a data context object, and walks the tree to produce output.

See [`docs/runtime-js.md`](../../docs/runtime-js.md) for the full API reference, usage examples, and type signatures.

## API

- `renderRoot(node, ctx, slots?)` — returns the complete HTML as a single string. Also auto-includes dom-patch scripts: it collects the `scriptUrl` of every reactive custom-element partial that actually rendered (deduped) and injects a `<script src="…" defer></script>` for each — before the first `</body>` if present, otherwise appended. See [docs/runtime-js.md](../../docs/runtime-js.md#dom-patch-script-auto-include).
- `streamRenderRoot(node, ctx, slots?)` — returns a `Generator<string>` yielding HTML chunks incrementally. Does not inject scripts (used internally for nested partials).

## Node types handled

- **raw** — passed through as-is
- **comment** — emitted verbatim as `<!--text-->`
- **print** — evaluates expression, HTML-escapes the result via `escapeHtml()`, and inserts it
- **for** — iterates over a collection (checked via `Symbol.iterator`), rendering children once per item with an augmented context
- **if** — evaluates branches in order, renders the first truthy one
- **partial-ref** — evaluates bindings in the caller's context, renders the referenced partial with a child context and slot map
- **slot** — renders injected content in the caller's original context
- **attr-bind** — dynamically sets an HTML attribute; boolean attributes are present/absent based on truthiness

## Testing

```bash
deno task test
```

`render_test.ts` covers the JS runtime.
