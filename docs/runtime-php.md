# BackflipHTML PHP Runtime

The PHP runtime renders compiled templates to HTML strings at request time. The workflow is:

1. **Compile once** — use the CLI to turn `.html` templates into `.php` files.
2. **Include at startup** — require `render.php` from the runtime.
3. **Load generated files** — use `backflip_require()` to load compiled templates.
4. **Render per request** — call `backflip_renderRoot` with a data context.

## Including the runtime

```php
require_once '/path/to/runtime/php/render.php';
```

## Loading a generated file

Use `backflip_require()` instead of plain `require` or `require_once`. It caches results internally so repeat calls within a request are cheap.

```php
$templates = backflip_require(__DIR__ . '/out/greeting.php');
// $templates['greeting']  ← node tree array
```

Each key in the returned array corresponds to a `b-name` partial in the source template.

## Rendering

```php
$html = backflip_renderRoot($templates['greeting'], ['name' => 'Alice']);
echo $html;
```

`backflip_renderRoot` returns the rendered HTML as a string.

## Signature

```php
backflip_renderRoot(array $node, array $ctx, array $slots = []): string
```

| Parameter | Description |
|-----------|-------------|
| `$node` | Node tree from `backflip_require()` |
| `$ctx` | Associative array; keys match the template variable names |
| `$slots` | Optional. Only needed when rendering a partial that declares a slot |

## JS truthiness

The PHP runtime evaluates conditions with **JavaScript semantics**, not PHP's native truthiness.

| Value | PHP truthiness | JS truthiness (used here) |
|-------|---------------|--------------------------|
| `"0"` | falsy | **truthy** |
| `[]`  | falsy | **truthy** |
| `0`   | falsy | falsy |
| `""`  | falsy | falsy |
| `null` | falsy | falsy |

Pass values accordingly. If your template has `b-if="someVar"` and `someVar` is `"0"`, the branch will render.
