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

The generated dom-patch JS is an **ES module** that *exports* a patch class — a library, not something the page runs directly. Your hand-coded web component imports that class and calls `customElements.define(...)`. So each reactive custom-element partial can carry up to two scripts:

- an **entry** module — the hand-coded web component, declared on the definition with [`b-script`](partials.md#client-script-b-script) (an `@asset/...` path). Injected as `<script src="…" type="module"></script>`.
- a **dependency** module — the generated dom-patch JS the entry imports. Its URL is derived at compile time from the asset prefix covering the dom-patch output dir (see [Assets](assets.md)). Injected as `<link rel="modulepreload" href="…">` so the browser fetches it in parallel with the entry that imports it, instead of waterfalling.

As the renderer walks the tree it collects the scripts of the reactive custom elements that **actually rendered** (deduped by URL, in first-encounter order) and emits the dependency `<link>`s first, then the entry `<script>`s:

- Placement: immediately before the first `</body>` (case-insensitive) when one exists; otherwise appended at the end of the output.
- Only rendered elements count — a custom element in an untaken `b-if`/`b-else` branch, or a `b-for` over an empty iterable, contributes nothing.
- No reactive custom elements rendered ⇒ no block is added.
- A partial with a generated dependency but no `b-script` entry has nothing to register the component; the build warns (see [CLI](cli.md)).

Both `renderRoot` and `streamRenderRoot` auto-include scripts, with **byte-identical output** — `renderRoot` is simply the collected chunks of `streamRenderRoot`. Streaming achieves the same placement without buffering the whole document: it streams the body straight through and only withholds the trailing `</body>…` tail (normally just `</body></html>`), flushing the block immediately before `</body>` once the full set of rendered scripts is known. Nested partials rendered inside a page never emit their own block — auto-include is a page-level concern. The single-node `render(...)` entry never injects.

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
