# Integration Tests

End-to-end tests that validate the complete pipeline: compile templates → generate code (JS or PHP) → render HTML.

## Running

From the repo root:

```bash
deno task test
```

This runs `deno test --allow-read --allow-write --allow-run=php,deno` and covers all tests in the project (compiler, runtime, preview, and these integration tests).

## Requirements

- **PHP tests** require `php` (8.1+) in PATH
- **CLI tests** spawn `deno` subprocesses

## Test files

| File | Covers |
|------|--------|
| `integration_test.ts` | JS pipeline: compile → generate JS → evaluate → render. Tests same-file and cross-file partial composition. |
| `integration_php_test.ts` | PHP pipeline: compile → generate PHP → execute via `php` subprocess → compare output. |
| `integration_error_test.ts` | Compilation error detection: structural errors, invalid directives, missing partials. |
| `cli_test.ts` | CLI argument parsing, config-based compilation, output directory handling. |

## Template fixtures

- **`templates/`** — valid templates used by integration tests: `simple.html`, `components.html`, `binds.html`, `blog.html`, `layout.html`, `page.html`, `ui.html`, `data.html`, `unary.html`
- **`templates-error/`** — templates with intentional errors for error-detection tests

## How the tests work

**Same-file JS tests** compile templates, generate JS via `fileToJsModule()`, strip `export const` keywords, evaluate with `new Function()`, and render with `renderRoot()`.

**Cross-file JS tests** write generated JS modules to a temp directory and use dynamic `import()` so that `import` statements between modules resolve correctly.

**PHP tests** write generated `.php` files to a temp directory, then invoke `php` as a subprocess to render and capture output.

A `normalize()` helper collapses whitespace between tags so templates can be formatted for readability without affecting assertions.
