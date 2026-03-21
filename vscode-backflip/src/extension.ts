import * as path from 'node:path';
import { workspace, ExtensionContext } from 'vscode';
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind,
} from 'vscode-languageclient/node.js';

let client: LanguageClient;

export function activate(context: ExtensionContext): void {
	// Server is bundled inside the extension at server/server.js
	const serverModule = context.asAbsolutePath(
		path.join('server', 'server.js')
	);

	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: { module: serverModule, transport: TransportKind.ipc },
	};

	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: 'file', language: 'html' }],
		synchronize: {
			fileEvents: workspace.createFileSystemWatcher('**/*.html'),
		},
	};

	client = new LanguageClient(
		'backflipHTML',
		'BackflipHTML Language Server',
		serverOptions,
		clientOptions,
	);

	client.start();
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) return undefined;
	return client.stop();
}
