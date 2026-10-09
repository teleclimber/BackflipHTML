# Configuration

Create a `backflip.json` file at the root of your project:

```json
{
  "root": "src/templates",
  "output": [{
    "lang": "js",
    "path": "dist/js"
  }],
  "assets": [
    {
      "name": "images",
      "path": "src/assets/img",
      "prefix": "/img/"
    }
  ]
}
```

| Field    | Required | Description                                          |
|----------|----------|------------------------------------------------------|
| `root`   | Yes      | Relative path to the directory containing `.html` templates |
| `output` | No       | Array of output entries; each entry has `lang` (`"js"`, `"php"`, or `"dom-patch"`) and `path` (relative output directory). The CLI compiles for every entry. |
| `assets` | No       | Array of asset directory configurations (see [Assets](assets.md)) |
| `stores` | No       | A directory, or an array of directories, holding store files (see [Data stores](data-stores.md)). A store directory inside an asset directory is served, so the browser can load its store files. |

Each output entry produces a separate set of files in its own directory. You can target a single language or multiple at once. Output paths must be unique within the array.

### `stores`

```json
{ "stores": ["static/scripts/stores", "server/stores"] }
```

Every `*.js` file under a store directory is a store file. See [Data stores](data-stores.md).

### `lang: "dom-patch"`

Generates the browser JavaScript for custom element partials that use [`b-generate`](dom-patch.md#b-generate) or `b-script`. For the renderer to auto-include it, an [asset](assets.md) entry must cover the output directory. See [Client-side patching → Build output](dom-patch.md#build-output).

## CLI

The [CLI](cli.md) reads `backflip.json` as a fallback when no arguments are provided. With a config file in your working directory, you can simply run:

```bash
backflip              # compile using config
backflip --check      # check for errors using config
```

CLI arguments override config `output` entries when both are present (the CLI form `<input> <output> --lang <js|php|dom-patch>` defines a single-output run).

When the output directories come from `backflip.json`, each is automatically emptied before writing. When provided via CLI arguments, the output directory must be empty.

## LSP

The [LSP server](../lsp/README.md) requires `backflip.json` in the workspace root. Without it, the language server stays inactive — no diagnostics, no go-to-definition, etc.

CSS files in [asset directories](assets.md) are automatically discovered for CSS analysis: hover info shows matching CSS rules for HTML elements, and hovering a CSS selector shows which template elements match.

## Preview

The [preview server](../preview/README.md) reads `backflip.json` to find the template directory. CSS files in asset directories are automatically injected into fragment previews so partials render with the project's styles. Document-level partials (with `<head>` and `<body>`) handle their own stylesheets via `<link>` tags in the template.
