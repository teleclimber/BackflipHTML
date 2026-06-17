# BackflipHTML JS Runtime

The JS runtime renders compiled templates to HTML at request time. It supports both **batch rendering** (returns a complete string) and **streaming** (yields string chunks via a generator). The workflow is:

1. **Compile once** — use the CLI to turn `.html` templates into `.js` modules.
2. **Import at startup** — import `renderRoot` (and/or `streamRenderRoot`) from the runtime and import the generated modules.
3. **Render per request** — call `renderRoot` for a string, or `streamRenderRoot` for incremental chunks.

## Importing the runtime

```ts
import { renderRoot, streamRenderRoot } from "https://raw.githubusercontent.com/teleclimber/BackflipHTML/main/runtime/js/render.ts";
import type { RootRNode } from "https://raw.githubusercontent.com/teleclimber/BackflipHTML/main/runtime/js/render.ts";
```

To pin a specific version, replace `main` with a tag or commit hash (same pattern as the CLI).

## Loading a generated module

Generated `.js` files are ES modules. Each `b-name` partial in the source template becomes a named export of type `RootRNode`.

```ts
import * as greetingModule from "./out/greeting.js";
// greetingModule.greeting  ← RootRNode
```

Import these once at startup; they are plain data structures and safe to reuse across requests.

## Rendering

### Batch (string)

```ts
const html = renderRoot(greetingModule.greeting, { name: "Alice" });
```

`renderRoot` returns the rendered HTML as a single string. Internally it collects all chunks from the streaming renderer.

### Streaming (generator)

```ts
for (const chunk of streamRenderRoot(greetingModule.greeting, { name: "Alice" })) {
    // write each chunk incrementally, e.g. to an HTTP response
    response.write(chunk);
}
```

`streamRenderRoot` returns a `Generator<string>` that yields HTML chunks as it walks the template tree. This is useful for large templates or when you want to start sending HTML before the full render is complete.

### dom-patch script auto-include

When you build with a `dom-patch` output, each reactive custom-element partial is stamped at compile time with the public URL of its generated JS (derived from the asset prefix covering the dom-patch output dir — see [Assets](assets.md)). As `renderRoot` walks the tree it collects the URLs of the reactive custom elements that **actually rendered** (deduped, in first-encounter order) and injects a `<script src="…" defer></script>` for each:

- Placement: immediately before the first `</body>` (case-insensitive) when one exists; otherwise appended at the end of the output.
- Only rendered elements count — a custom element in an untaken `b-if`/`b-else` branch, or a `b-for` over an empty iterable, contributes nothing.
- No reactive custom elements rendered ⇒ no `<script>` block is added.

`streamRenderRoot` does **not** inject scripts (it is also used internally for nested partials); auto-include is a `renderRoot` page-level concern. The single-node `render(...)` entry never injects.

## Signatures

```ts
renderRoot(n: RootRNode, ctx: object, slots?: SlotMap): string

streamRenderRoot(n: RootRNode, ctx: object, slots?: SlotMap): Generator<string>
```

| Parameter | Description |
|-----------|-------------|
| `n` | The `RootRNode` exported from a generated module |
| `ctx` | Plain object; keys match the template variable names |
| `slots` | Optional. Only needed when rendering a partial that declares `<b-slot>` |

## Key types

```ts
export interface RootRNode {
    type: 'root';
    nodes: RNode[];
}

export type SlotMap = { [name: string]: { nodes: RNode[], ctx: any } }
```

## `escapeHtml` utility

`escapeHtml` is also exported from the runtime:

```ts
import { escapeHtml } from "https://raw.githubusercontent.com/teleclimber/BackflipHTML/main/runtime/js/render.ts";

escapeHtml(s: string): string
```

Use it if you need to HTML-escape values outside of template rendering. Template `{{ }}` expressions are already escaped automatically.
