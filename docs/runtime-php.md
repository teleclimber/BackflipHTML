# BackflipHTML PHP Runtime

The PHP runtime renders compiled templates to HTML at request time. It supports both **batch rendering** (returns a complete string) and **streaming** (yields string chunks via a generator). The workflow is:

1. **Compile once** — use the CLI to turn `.html` templates into `.php` files.
2. **Include at startup** — require `render.php` from the runtime.
3. **Load generated files** — use `backflip_require()` to load compiled templates.
4. **Render per request** — call `backflip_renderRoot` for a string, or `backflip_streamRenderRoot` for incremental chunks.

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

### Batch (string)

```php
$html = backflip_renderRoot($templates['greeting'], ['name' => 'Alice']);
echo $html;
```

`backflip_renderRoot` returns the rendered HTML as a single string. Internally it collects all chunks from the streaming renderer.

### Streaming (generator)

```php
foreach (backflip_streamRenderRoot($templates['greeting'], ['name' => 'Alice']) as $chunk) {
    // write each chunk incrementally, e.g. flush to the client
    echo $chunk;
    flush();
}
```

`backflip_streamRenderRoot` returns a `Generator` that yields HTML string chunks as it walks the template tree. This is useful for large templates or when you want to start sending output before the full render is complete.

### dom-patch script auto-include

When you build with a `dom-patch` output, a reactive custom-element partial can carry two scripts: an **entry** module (the hand-coded web component, declared with [`b-script`](partials.md#client-script-b-script)) injected as `<script type="module">`, and a **dependency** module (the generated dom-patch JS the entry imports, whose URL is derived from the asset prefix covering the dom-patch output dir — see [Assets](assets.md)) injected as `<link rel="modulepreload">`. As the renderer walks the tree it collects the scripts of the reactive custom elements that **actually rendered** (deduped by URL, in first-encounter order) and emits the dependency `<link>`s first, then the entry `<script>`s. This mirrors the [JS runtime](runtime-js.md#dom-patch-script-auto-include) exactly.

- Placement: immediately before the first `</body>` (case-insensitive) when one exists; otherwise appended at the end of the output.
- Only rendered elements count — a custom element in an untaken `b-if`/`b-else` branch, or a `b-for` over an empty iterable, contributes nothing.
- No reactive custom elements rendered ⇒ no block is added.

Both `backflip_renderRoot` and `backflip_streamRenderRoot` auto-include scripts, with **byte-identical output** — `backflip_renderRoot` is simply the collected chunks of `backflip_streamRenderRoot`. Streaming achieves the same placement without buffering the whole document: it streams the body straight through and only withholds the trailing `</body>…` tail (normally just `</body></html>`), flushing the block immediately before `</body>` once the full set of rendered scripts is known. Nested partials rendered inside a page never emit their own block — auto-include is a page-level concern.

## Signatures

```php
backflip_renderRoot(array $node, array $ctx, array $slots = []): string

backflip_streamRenderRoot(array $node, array $ctx, array $slots = []): Generator
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
