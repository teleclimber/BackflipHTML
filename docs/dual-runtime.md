# Dual-Runtime Support

The compiler, generators, and JS runtime are importable from both **Deno** and **Node.js**.

## Deno

Import directly from `mod.ts`. Bare specifiers like `acorn` and `parse5-html-rewriting-stream` are mapped via `deno.json` import maps.

```ts
import { compileDirectory, fileToJsModule } from "./mod.ts";
```

## Node.js

Run `npm run build` to compile TypeScript to `dist/`, then import from `dist/mod.js`. The `package.json` exports field points here.

```bash
npm install
npm run build
```

```ts
import { compileDirectory, fileToJsModule } from "@backflip/html";
// or: import { compileDirectory } from "./dist/mod.js";
```

Verify the build works:

```bash
node -e "import('./dist/mod.js').then(m => console.log(Object.keys(m)))"
```
