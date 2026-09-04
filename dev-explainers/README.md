# Developer explainers

Tools that show **how** a subsystem reaches its results, for the people working
on that subsystem. They are development aids, not part of what BackflipHTML
ships — nothing here is imported by the compiler, the runtime, the LSP, or the
preview server.

An explainer calls the real code and reports what it observed at each stage. It
never re-implements the thing it explains: a tool that models a subsystem
separately drifts from it, and then teaches something that is no longer true.

Explainers reach into their subject's internals directly. They are development
aids with a short life, so the flow of accommodation runs one way — an explainer
follows the code it explains, and the code owes it nothing. A subsystem should
never grow an export just to be explainable.

| Explainer | Subject |
|---|---|
| [`css-analysis/`](css-analysis/README.md) | How `@backflip/css` turns a stylesheet and a template directory into per-element match results |

## Setup

```bash
npm install --prefix dev-explainers   # links @backflip/html; css/src is imported by path
npm run build                         # from the repo root; @backflip/html resolves to dist/
```

## Testing

```bash
npm --prefix dev-explainers test
```
