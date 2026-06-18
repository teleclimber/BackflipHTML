# PHP Runtime

Renders compiled template trees into HTML. Takes a node tree array (produced by loading a generated `.php` file via `backflip_require()`) plus a data context array, and walks the tree to produce output.

See [`docs/runtime-php.md`](../../docs/runtime-php.md) for the full API reference, usage examples, and truthiness details.

## API

- `backflip_renderRoot($node, $ctx, $slots)` — returns the complete HTML as a single string. Defined as the collected chunks of `backflip_streamRenderRoot`, so it shares its dom-patch script auto-include behavior.
- `backflip_streamRenderRoot($node, $ctx, $slots)` — returns a `Generator` yielding HTML chunks incrementally. Auto-includes dom-patch scripts before the first `</body>` (otherwise appended), withholding only the trailing `</body>…` tail while streaming so output stays byte-identical to batch. Nested partials do not inject their own scripts. See [docs/runtime-php.md](../../docs/runtime-php.md#dom-patch-script-auto-include).
- `backflip_require($path)` — loads generated PHP files with static caching (works around `require_once` returning `1` on repeat calls)
- `backflip_isTruthy($val)` — evaluates truthiness using JavaScript semantics, not PHP's

## JS truthiness

The PHP runtime evaluates conditions with **JavaScript semantics**. This matters because PHP and JS disagree on some values:

| Value | PHP | JS (used here) |
|-------|-----|-----------------|
| `"0"` | falsy | **truthy** |
| `[]`  | falsy | **truthy** |

Use `backflip_isTruthy()` — never a bare PHP boolean cast.

## Testing

```bash
deno task test
```

PHP integration tests are in `test/integration_php_test.ts` and require `php` (8.1+) in PATH.
