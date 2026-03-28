# Partial Preview

Preview partials in isolation to see how they render with mock data — no backend or real data required.

---

## How it works

The preview system:

1. **Compiles** the partial using the standard BackflipHTML compiler
2. **Generates mock data** from the partial's inferred data shape (the types and usage patterns of its variables)
3. **Fills slots** with grey placeholder blocks (since no caller provides slot content)
4. **Renders** the partial using the JS runtime, producing an HTML preview
5. **Includes the project's CSS** if a `stylesheet` is configured in `backflip.json`

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

## VSCode integration

### Preview Partial command

1. Open an HTML template file
2. Place cursor inside a partial (between its `b-name` opening and closing tags)
3. Run **BackflipHTML: Preview Partial** from:
   - The Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
   - Right-click context menu in HTML files

A webview panel opens beside the editor showing the rendered preview. The preview auto-refreshes when you save the file.

---

## Programmatic API

The preview module can be used independently of the LSP and VSCode:

```typescript
import { compileDirectory } from '@backflip/html';
import { previewPartial } from '@backflip/html';

const { directory } = await compileDirectory('./templates');

const result = await previewPartial({
    partialName: 'card',
    compiledFile: directory.files.get('components.html'),
    allFiles: directory.files,       // needed for cross-file b-part refs
    fileName: 'components.html',
    cssContent: 'body { margin: 0; }', // optional project CSS
    dataOverrides: { title: 'Custom' }, // optional overrides
});

console.log(result.html);     // complete HTML document
console.log(result.mockData); // generated mock data
console.log(result.errors);   // any non-fatal issues
```

---

## Document-level partials

Partials that contain `<html>`, `<head>`, or `<body>` tags are handled specially — the preview injects styles into the existing `<head>` rather than wrapping in another document, and shows a floating overlay with the partial name.
