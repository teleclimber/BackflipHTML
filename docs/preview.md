# Partial Preview

Preview partials in isolation to see how they render with mock data — no backend or real data required.

---

## How it works

The preview system:

1. **Compiles** the partial using the standard BackflipHTML compiler
2. **Generates mock data** from the partial's inferred data shape (the types and usage patterns of its variables)
3. **Fills slots** with grey placeholder blocks (since no caller provides slot content)
4. **Renders** the partial using the JS runtime, producing an HTML preview
5. **Includes the project's CSS** — any `.css` files found in [asset directories](assets.md) are automatically injected into fragment previews

---

## Mock data generation

The preview system infers what data each partial needs by examining how variables are used:

| Variable usage | Mock value |
|---|---|
| `{{ title }}` (printed) | The variable name as a string: `"title"` |
| `b-if="visible"` (boolean) | `true` (shows the truthy branch) |
| `b-for="item in items"` (iterable) | Array of 3 items |
| `b-bind:href="url"` (attribute) | Sensible defaults: `href` → `"#"`, `class` → `"sample-class"`, `src` → placeholder image URL |
| `b-data:user="currentUser"` (passed) | Shape resolved from the called partial's data requirements |
| `user.name` (property chain) | Nested object: `{ name: "name" }` |

### Cross-partial data resolution

When a partial passes data to a child partial via `b-data:`, the preview system looks up the child partial's data shape to determine what the passed variable needs. For example:

```html
<!-- page partial -->
<div b-part="#card" b-data:user="currentUser"></div>

<!-- card partial -->
<h1>{{ user.name }}</h1>
<p b-if="user.active">Active</p>
```

The mock data for `currentUser` is generated as `{ name: "name", active: true }` because the `card` partial requires `user.name` (printed) and `user.active` (boolean).

### Data overrides

You can provide custom data overrides via the `dataOverrides` option in the preview API to replace specific mock values with real ones.

---

## Slot placeholders

Partials that declare slots (via `b-slot`) render grey placeholder blocks in the preview, since there is no caller to provide slot content.

For nested partials referenced via `b-part`:
- Slots that the previewed partial fills (via `b-in`) render the provided content
- Unfilled slots in child partials render empty (accurate behavior)

---

## dom-patch reactivity

Custom-element partials with reactive attributes compile to a [dom-patch](../compiler/generate/dom-patch/README.md) JS class that updates specific elements in the browser. Each patchable element is tagged with a `data-bfid` marker that the class locates via `querySelector`.

Because bfids are generated per compile, the JS emitted by a separate `backflip build` would query ids that don't match what the preview renders. So the preview **regenerates the dom-patch JS on each render and serves that** instead of the on-disk build output — guaranteeing the served class queries the exact bfids in the previewed HTML.

The preview computes, for each generated file, the absolute path the build *would* write it to (from the [`dom-patch` output dirs](configuration.md)) and maps it to where the fresh copy was actually saved. Any asset request that resolves to one of those build paths is served the fresh copy. This works whether a dom-patch output dir equals an asset dir or sits in a subdirectory of one.

- **Standalone server**: an asset request whose resolved disk path matches a dom-patch build destination is served from a session temp dir (falling through to disk if a file has no reactive partials).
- **VSCode**: the same freshly generated JS is written to a temp dir and loaded into the webview by remapping the matching asset URLs.

No template changes are needed — the existing `@<name>/<file>.js` asset reference is resolved transparently.

---

## VSCode integration

### Preview Partial command

1. Open an HTML template file
2. Place cursor inside a partial (between its `b-name` opening and closing tags)
3. Run **BackflipHTML: Preview Partial** from:
   - The Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
   - Right-click context menu in HTML files

A webview panel opens beside the editor showing the rendered preview. The preview auto-refreshes when you save the file.

**Note:** VSCode injects its own default styles (font-size, font-family, colors, etc.) into webview panels via `@layer vscode-default`. These styles affect the preview and cannot be reliably overridden. The standalone preview server (`npm run preview`) is not affected. If accurate styling matters, use the standalone server or ensure your project's CSS explicitly sets base styles like `font-size` on `body`.

### Jump to Source

Right-click on any element in the preview to see a **Go to Source** option that navigates to the corresponding line in the HTML template. This works by injecting `data-loc` attributes into rendered elements during compilation (via the `includeLocs` option). The LSP enables this automatically for preview.

---

## Programmatic API

The preview module can be used independently of the LSP and VSCode:

```typescript
import { compileDirectory } from '@backflip/html';
import { previewPartial } from '@backflip/html';

const { directory } = await compileDirectory('./templates', { includeLocs: true });

const result = await previewPartial({
    partialName: 'card',
    compiledFile: directory.files.get('components.html'),
    allFiles: directory.files,       // needed for cross-file b-part refs
    fileName: 'components.html',
    cssHrefs: ['/assets/styles.css'],    // optional CSS links for fragment preview
    dataOverrides: { title: 'Custom' }, // optional overrides
    domPatchOutputDirs: ['/abs/server/static-bfdom'], // optional: absolute dom-patch build dirs
    domPatchOutDir: '/tmp/bfdom',        // optional: where to write freshly generated dom-patch JS
});

console.log(result.html);           // complete HTML document
console.log(result.mockData);       // generated mock data
console.log(result.errors);         // any non-fatal issues
console.log(result.domPatchAssets); // { buildDestPath: savedPath } for dom-patch JS this render
```

---

## Document-level partials

Partials that contain `<html>`, `<head>`, or `<body>` tags are handled specially — the preview injects styles into the existing `<head>` rather than wrapping in another document, and shows a floating overlay with the partial name.
