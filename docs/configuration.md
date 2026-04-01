# Configuration

Create a `backflip.json` file at the root of your project:

```json
{
  "root": "src/templates",
  "output": "dist",
  "lang": "js",
  "stylesheet": "styles/global.css"
}
```

| Field        | Required | Description                                          |
|--------------|----------|------------------------------------------------------|
| `root`       | Yes      | Relative path to the directory containing `.html` templates |
| `output`     | No       | Relative path to the output directory (used by CLI)  |
| `lang`       | No       | Output language: `"js"` or `"php"` (used by CLI)    |
| `stylesheet` | No       | Relative path to a global CSS stylesheet (for LSP and preview) |

## CLI

The [CLI](cli.md) reads `backflip.json` as a fallback when no arguments are provided. With a config file in your working directory, you can simply run:

```bash
backflip              # compile using config
backflip --check      # check for errors using config
```

CLI arguments override config values when both are present.

When the output directory comes from `backflip.json`, it is automatically emptied before writing. When provided via CLI arguments, the output directory must be empty.

## LSP

The [LSP server](../lsp/README.md) requires `backflip.json` in the workspace root. Without it, the language server stays inactive — no diagnostics, no go-to-definition, etc.

The `stylesheet` field enables CSS analysis: hover info shows matching CSS rules for HTML elements, and hovering a CSS selector shows which template elements match.

## Preview

The [preview server](../preview/README.md) reads `backflip.json` to find the template directory and stylesheet. The stylesheet is served to preview pages so partials render with the project's styles.
