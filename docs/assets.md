# Assets

BackflipHTML allows you to configure asset directories that live outside of the template directories. This is useful for referencing static assets like images, CSS, or other files in your templates. The compiler ensures that references to these assets are valid and maps them to their correct output paths.

## Configuration

Asset directories are defined in `backflip.json` under the `assets` key:

```json
{
  "root": "src/templates",
  "output": "dist",
  "assets": [
    {
      "name": "images",
      "path": "src/assets/img",
      "prefix": "/img/"
    },
    {
      "name": "styles",
      "path": "src/assets/css",
      "prefix": "https://cdn.example.com/css/"
    }
  ]
}
```

- **`name`**: The identifier used to reference this directory in your templates. Must be alphanumeric with dashes and underscores only (no spaces or slashes).
- **`path`**: The relative path to the directory containing the assets, relative to `backflip.json`.
- **`prefix`**: The string (e.g., path or URL) that replaces the directory reference in the rendered HTML output. Must have a trailing slash.

## Referencing Assets

To use an asset in a template, append a `~` to the attribute name. The attribute value must start with `@` followed by the asset directory `name` configured in `backflip.json`.

```html
<img src~="@images/logo.png" />
<link rel="stylesheet" href~="@styles/main.css" />
```

At compile time, the `~` is removed and the `@name` part is replaced with the corresponding `prefix`. The output of the above example, using the configuration above, would be:

```html
<img src="/img/logo.png" />
<link rel="stylesheet" href="https://cdn.example.com/css/main.css" />
```

### Dynamic Asset Paths

You can also reference assets dynamically using `b-bind` or the `:` shorthand. The `~` must still be placed at the end of the attribute name.

```html
<img :src~="'@images/' + user.avatar" />
```

For dynamic bindings, the path replacement happens at runtime by the language specific renderer.

### `srcset` Attribute

The `srcset` attribute is fully supported. BackflipHTML parses the `srcset` value and maps each asset path individually.

```html
<img srcset~="@images/small.jpg 480w, @images/large.jpg 800w" />
```

*Note: Attributes with multiple URLs other than `srcset` (like inline `style`) are not currently supported for asset resolution.*

## Tooling Integration

By declaring your assets, BackflipHTML provides compile-time guarantees and editor assistance:

- **Validation**: The compiler throws errors if an asset directory name is undefined, if a path attempts directory traversal outside the asset folder (`../`), or if the referenced file does not exist. When an asset directory doubles as a [`dom-patch` output directory](configuration.md), the build generates files into it; the "file does not exist" check runs *after* those files are written, so generated assets validate correctly while references no build produces are still reported as missing.
- **Language Server (LSP)**: The VSCode extension provides auto-completion for asset paths, hover previews (with image dimensions), go-to-definition, and red squiggles for missing files. It also provides an Asset Report panel.
- **Preview Server**: The preview server automatically resolves and serves assets, allowing you to preview templates with images and CSS without needing a separate build step.

## Asset Reporting

You can use the BackflipHTML CLI to generate a report showing which assets are used across your templates and which ones are unused.

```bash
backflip --assets-report
```

If any unused assets are found, the command exits with code `1`, making it useful for CI pipelines to enforce that dead assets are removed. You can use the `--unused-only` flag to only list unused assets, or `--json` to get the raw report output. See the [CLI documentation](cli.md) for more details.
