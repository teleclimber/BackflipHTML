# VSCode Extension

A VSCode extension that launches the BackflipHTML language server and provides:

- TextMate grammar injection for `b-*` directive highlighting and `{{ }}` interpolation
- Language configuration for bracket matching and auto-closing pairs
- **Preview Partial** command — right-click in an HTML template or use the Command Palette to open a live preview panel

## Building & installing

From the repo root, build and package everything in one step:

```bash
npm run build:extension
```

This builds the compiler, LSP server, and extension, then packages it as a `.vsix` file. Install the resulting `vscode-backflip/vscode-backflip-0.1.0.vsix` via the command palette (**Extensions: Install from VSIX...**) or:

```bash
code --install-extension vscode-backflip/vscode-backflip-0.1.0.vsix --force
```

Then **reload the window**.

Two things that make a rebuild look like it worked when it didn't:

- **`--force` is not optional for a rebuild.** The version in `package.json` does
  not change between builds, so without it VS Code sees `0.1.0` already installed
  and skips the new package — leaving you on the old server with no error.
- **Packaging is the last step, so it fails last.** If `@vscode/vsce` is missing,
  every compile step still succeeds and only the final line reads
  `vsce: not found`. `server/server.cjs` is freshly built, `dist/extension.js` is
  freshly built, and the `.vsix` is untouched from the previous build. Run
  `npm install` here to get `vsce`.

The extension runs the server bundled *inside the installed extension*
(`server/server.cjs` in the installed copy under `~/.vscode-server/extensions/`
or `~/.vscode/extensions/`). Rebuilding `lsp/` — or even
`vscode-backflip/server/server.cjs` — changes nothing until you repackage and
reinstall. To check which build is actually live:

```bash
grep -c cssFailuresToDiagnostics ~/.vscode-server/extensions/backflip.vscode-backflip-*/server/server.cjs
```

For **remote development** (SSH, WSL, Dev Containers), the extension must be installed on the remote side — the LSP server needs direct access to the project files.
