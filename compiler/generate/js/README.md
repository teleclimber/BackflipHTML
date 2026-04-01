# JavaScript Code Generator

Converts the compiler's language-agnostic AST into JavaScript ES modules.

The work is split into two layers:

- **`generatejs.ts`** — handles individual expressions. Takes a `Parsed` expression object and produces a JS function string (e.g. `function f(item) { return item.name; }`). Member access and identifiers pass through unchanged since the expression language is a subset of JavaScript.

- **`nodes2js.ts`** — handles the full tree. Walks the `TNode` tree and emits a JS module where each partial is a named export (`export const nodes = ...`). Each expression is replaced by a `{ fn: ..., vars: [...] }` object. Cross-file `b-part` references become `import` statements at the top of the module.

The output is a `.js` file that, when imported, provides `RootRNode` trees ready for [`runtime/js/`](../../../runtime/README.md).

## Testing

```bash
deno task test
```

- `generatejs_test.ts` — expression → JS function
- `nodes2js_test.ts` — AST → JS module output
