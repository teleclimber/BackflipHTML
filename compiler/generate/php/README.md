# PHP Code Generator

Converts the compiler's language-agnostic AST into PHP files.

The work is split into two layers:

- **`generatephp.ts`** — handles individual expressions. Takes a `Parsed` expression object and produces a PHP closure string (e.g. `function($item) { return $item['name']; }`). Member access is translated to associative array syntax: `user.name` becomes `$user['name']`.

- **`nodes2php.ts`** — handles the full tree. Walks the `TNode` tree and emits a PHP file where each partial is a PHP array variable with the same structure as the JS output, with each expression replaced by a `['fn' => ..., 'vars' => [...]]` array. Cross-file `b-part` references are loaded via `backflip_require()`. The file ends with `return compact(...)` so it can be loaded as a module.

The output is a `.php` file that, when loaded via `backflip_require()`, returns an associative array of partial node trees ready for [`runtime/php/`](../../../runtime/README.md).

## Testing

```bash
deno task test
```

- `generatephp_test.ts` — expression → PHP closure
- `nodes2php_test.ts` — AST → PHP file output
