# Integration Tests

End-to-end tests that validate the complete pipeline: compile templates → generate JS → render HTML.

## Running

From the repo root:

```bash
deno task test
```

This runs `deno test --allow-read --allow-write --allow-env --allow-run=deno` and covers all tests in the project (compiler, runtime, preview, and these integration tests).

## Requirements

- **CLI tests** spawn `deno` subprocesses

## Test files

| File | Covers |
|------|--------|
| `integration_test.ts` | JS pipeline: compile → generate JS → evaluate → render. Tests same-file and cross-file partial composition. |
| `integration_error_test.ts` | Compilation error detection: structural errors, invalid directives, missing partials. |
| `cli_test.ts` | CLI argument parsing, config-based compilation, output directory handling. |
| `dom_patch_autoinclude_test.ts` | Script auto-include: the module each `b-generate` mode contributes, its URL, and where the renderer injects it. |
| `dom_patch_if_test.ts` | Reactive `b-if` and nested set descriptors, plus the runtime (`runtime/js/render.js`, `runtime/dom-patch/patch.js`) the CLI copies beside generated modules. |
| `dom_patch_generate_test.ts` | `b-generate="full"` end to end: CLI build → server render → the generated module patching that HTML in jsdom. |
| `dom_patch_for_test.ts` | Reactive `b-for` end to end: CLI build → server render → the generated module adding, removing, moving and updating items in jsdom. |
| `stores_compile_test.ts` | Store compile errors over the `stores-project/` fixture, with a served and an unserved store dir. |
| `stores_render_test.ts` | Stores at render time: which stores a page ships, the escaping of their JSON, and render errors. |
| `stores_generate_test.ts` | A generated partial reading a store end to end: CLI build → server render with store data → the module, store file and runtime in jsdom. |

## Template fixtures

- **`templates/`** — valid templates used by integration tests: `simple.html`, `components.html`, `binds.html`, `blog.html`, `layout.html`, `page.html`, `ui.html`, `data.html`, `unary.html`
- **`templates-error/`** — templates with intentional errors for error-detection tests
- **`stores-project/`** — a project with store files in a served dir (`static/stores/`) and an unserved one (`server/stores/`), with valid templates and templates with store errors

## How the tests work

**Same-file JS tests** compile templates, generate JS via `fileToJsModule()`, strip `export const` keywords, evaluate with `new Function()`, and render with `renderRoot()`.

**Cross-file JS tests** write generated JS modules to a temp directory and use dynamic `import()` so that `import` statements between modules resolve correctly.

A `normalize()` helper collapses whitespace between tags so templates can be formatted for readability without affecting assertions.
