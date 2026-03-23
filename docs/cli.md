# BackflipHTML CLI

## Installation

Run the CLI directly from the GitHub repo using Deno:

```sh
deno run --allow-read --allow-write https://raw.githubusercontent.com/teleclimber/BackflipHTML/main/cli.ts
```

No local installation or compilation is needed — Deno fetches and caches the module automatically.

To pin a specific tagged version or commit hash, replace `main` in the URL:

```sh
# Use a tagged version
deno run --allow-read --allow-write https://raw.githubusercontent.com/teleclimber/BackflipHTML/v0.1.0/cli.ts

# Use a specific commit hash
deno run --allow-read --allow-write https://raw.githubusercontent.com/teleclimber/BackflipHTML/abc1234/cli.ts
```

For convenience you can create a shell alias:

```sh
alias backflip="deno run --allow-read --allow-write https://raw.githubusercontent.com/teleclimber/BackflipHTML/main/cli.ts"
```

## Generate mode

Compile HTML templates and write output files:

```sh
backflip <input-dir> <output-dir> --lang <js|php>
```

- `<input-dir>` — directory of `.html` template files (scanned recursively)
- `<output-dir>` — must be empty (when provided via CLI); output files mirror the input directory structure
- `--lang js` — generate JavaScript modules (`.js`)
- `--lang php` — generate PHP files (`.php`)

**Examples:**

```sh
# Generate JS files
backflip ./templates ./out --lang js

# Generate PHP files
backflip ./templates ./out --lang php
```

When the output directory is specified via CLI arguments, it must be empty before running. When the output directory comes from `backflip.json`, it is automatically emptied before writing. The input hierarchy is preserved, with `.html` extensions replaced by `.js` or `.php`.

## Check mode

Validate templates for compile errors without writing any output:

```sh
backflip <input-dir> --check [--json]
```

- `--check` — report errors only, no files written
- `--json` — format errors as JSON (useful for editor integrations)

**Examples:**

```sh
# Plain text error output
backflip ./templates --check

# JSON error output
backflip ./templates --check --json
# => { "errors": [] }
# => { "errors": ["In \"blog/post.html\": ..."] }
```

## Exit codes

| Code | Meaning |
|------|---------|
| `0`  | Success (generate: files written; check: no errors) |
| `1`  | Error (compile error, invalid arguments, or non-empty output directory) |
