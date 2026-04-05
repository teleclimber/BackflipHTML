# Assets Implementation

This package handles the discovery, tracking, and reporting of static assets referenced in BackflipHTML templates. It powers the CLI's `--assets-report` feature and the VSCode extension's asset reporting panel.

## Components

### Asset Discovery (`discover.ts`)

Scans the filesystem for asset files based on the `assets` configuration in `backflip.json`. It identifies file sizes, extensions, and whether a file is an image (for thumbnail generation).

- `discoverAssetFiles()` — returns a list of absolute paths to all assets in configured directories.
- `discoverAssetFileInfos()` — returns detailed metadata for each discovered asset.

### Reference Collection (`references.ts`)

Analyzes compiled template ASTs to find all occurrences of asset references (attributes ending in `~` or starting with `@`). It tracks which partial and which line number contains each reference.

- `collectAllAssetReferences()` — walks a `CompiledDirectory` (and optionally configured asset directories) to extract all asset usage from templates and CSS files.

### Usage Reporting (`report.ts`)

Correlates discovered asset files with collected references to build a comprehensive usage report.

- `buildAssetUsageReport()` — creates a report containing a summary (total/used/unused counts) and detailed entries for every asset file.
- `filterReport()` — utility to filter reports (e.g., to show only unused assets).

### HTML Rendering (`render.ts`)

Renders the asset usage report as a self-contained, interactive HTML page. This is used by the VSCode extension to display the report in a webview panel.

- `renderAssetReportHtml()` — generates an HTML string with a grid of assets, image thumbnails, usage badges, and expandable reference lists.

## Usage Docs

- [Assets documentation](../docs/assets.md) — how to configure and use assets in templates.
- [CLI documentation](../docs/cli.md) — how to run asset reports from the command line.

## Testing

Tests for asset logic run via Deno from the repo root:

```bash
deno task test
```

| File | Covers |
|------|--------|
| `discover.test.ts` | File discovery and metadata extraction |
| `references.test.ts` | Template AST scanning for `~` and `@` |
| `report.test.ts` | Correlating files with references |
| `render.test.ts` | HTML report generation |
