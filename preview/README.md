# Preview

The preview system renders partials with auto-generated mock data — no backend or real data required. It infers what data each partial needs from its data shape and generates plausible values.

See [`docs/preview.md`](../docs/preview.md) for the full reference including the programmatic API, VSCode integration, data overrides, and document-level partial handling.

## Preview server

Run a local server to browse and preview all partials in the browser:

```bash
npm run preview
```

This compiles templates from `backflip.json`, starts a server at `http://localhost:3000`, and shows a list of all files and partials. Click any partial to see its rendered preview.

Use `--port` to change the port:

```bash
npx tsx preview/server.ts --port 8080
```

The server watches for changes to templates, CSS, and `backflip.json`. When a file changes, templates are recompiled and the browser reloads automatically via Server-Sent Events.

## Key features

- **Mock data generation** — printed variables become their name as a string, booleans become `true`, iterables become arrays of 3 items, attributes get sensible defaults (`href` → `"#"`, `src` → placeholder image URL)
- **Cross-partial data resolution** — when a partial passes data to a child via `b-data:`, the mock data is shaped to match the child partial's requirements
- **Slot placeholders** — unfilled slots render as grey placeholder blocks
- **CSS inclusion** — automatically includes CSS files from configured asset directories
- **Live reload** — file changes trigger recompilation and browser reload via SSE

## Key files

| File | Purpose |
|------|---------|
| `server.ts` | HTTP server, request routing, file watching, SSE live reload |
| `preview.ts` | Partial evaluation and rendering pipeline |
| `mock-data.ts` | Mock data generation from DataShape |
| `preview-chrome.ts` | HTML wrapper with dev toolbar and context menu script |
| `slot-placeholders.ts` | Placeholder content generation for unfilled slots |

## Testing

Preview tests run via Deno from the repo root:

```bash
deno task test
```

Test files: `server_test.ts`, `preview_test.ts`, `mock-data_test.ts`, `preview-chrome_test.ts`, `slot-placeholders_test.ts`.
