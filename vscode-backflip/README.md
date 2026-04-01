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
code --install-extension vscode-backflip/vscode-backflip-0.1.0.vsix
```

For **remote development** (SSH, WSL, Dev Containers), the extension must be installed on the remote side — the LSP server needs direct access to the project files.
