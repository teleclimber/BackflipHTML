# Runtime

The runtime renders compiled template trees into HTML. It takes a tree structure where every expression is already a callable function, plus a data context, and walks the tree to produce output.

Two implementations are provided with identical behavior. Both are streaming-first: rendering is done via generators that yield string chunks, so HTML can be emitted incrementally.

- **[`js/`](js/README.md)** — JavaScript runtime. See [`docs/runtime-js.md`](../docs/runtime-js.md) for the usage API.
- **[`php/`](php/README.md)** — PHP runtime. See [`docs/runtime-php.md`](../docs/runtime-php.md) for the usage API.

## Testing

Runtime tests run via Deno from the repo root:

```bash
deno task test
```

PHP integration tests require `php` (8.1+) in PATH.
