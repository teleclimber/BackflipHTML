import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { loadConfig, resolveConfigRoot } from '../compiler/config.js';
import { compileDirectory, type CompiledDirectory } from '../compiler/partials.js';
import { previewPartial } from './preview.js';
import type { CompiledFile } from '../compiler/compiler.js';
import { createWatcher } from '../lib/watch.js';

export interface ServerContext {
	directory: CompiledDirectory;
	cssPath: string;
	templateRoot: string;
}

/** Build the server context: compile templates and load CSS. */
export async function buildContext(projectDir: string): Promise<ServerContext> {
	const config = await loadConfig(projectDir);
	if (!config) {
		throw new Error('backflip.json not found — run from a project directory with a backflip.json');
	}

	const inputDir = resolveConfigRoot(projectDir, config);
	const { directory, errors } = await compileDirectory(inputDir);
	if (errors.length > 0) {
		for (const err of errors) console.error(err.message);
		throw new Error(`Compilation failed with ${errors.length} error(s)`);
	}

	let cssPath = '';
	if (config.stylesheet) {
		cssPath = path.resolve(projectDir, config.stylesheet);
	}

	return { directory, cssPath, templateRoot: inputDir };
}

/** Build a tree structure from the compiled directory for the index page. */
function buildTree(files: Map<string, CompiledFile>): { file: string; partials: string[] }[] {
	const entries: { file: string; partials: string[] }[] = [];
	for (const [filePath, compiled] of files) {
		const partials = Array.from(compiled.partials.keys());
		if (partials.length > 0) {
			entries.push({ file: filePath, partials });
		}
	}
	entries.sort((a, b) => a.file.localeCompare(b.file));
	return entries;
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** Render the index page listing all files and partials. */
export function renderIndex(files: Map<string, CompiledFile>, liveReload = false): string {
	const tree = buildTree(files);
	let list = '';
	for (const entry of tree) {
		list += `<li><strong>${escapeHtml(entry.file)}</strong><ul>`;
		for (const name of entry.partials) {
			const href = `/preview/${encodeURIComponent(entry.file)}/${encodeURIComponent(name)}`;
			list += `<li><a href="${escapeHtml(href)}">${escapeHtml(name)}</a></li>`;
		}
		list += `</ul></li>`;
	}

	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Backflip Previews</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; color: #333; }
h1 { font-size: 1.4em; }
ul { list-style: none; padding-left: 1.2em; }
ul ul { padding-left: 1.5em; }
li { margin: 4px 0; }
a { color: #0969da; text-decoration: none; }
a:hover { text-decoration: underline; }
strong { font-weight: 600; }
</style>
</head>
<body>
<h1>Backflip Previews</h1>
<ul>${list}</ul>
${liveReload ? '<script>(function(){var es=new EventSource("/__events");es.addEventListener("reload",function(){location.reload()})})();</script>' : ''}
</body>
</html>`;
}

/** Broadcast a reload event to all connected SSE clients. */
export function broadcastReload(clients: Set<http.ServerResponse>): void {
	for (const client of clients) {
		client.write('event: reload\ndata: {}\n\n');
	}
}

/** Handle an HTTP request. Exported for testing. */
export async function handleRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	ctx: ServerContext,
	sseClients?: Set<http.ServerResponse>,
): Promise<void> {
	const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
	const pathname = decodeURIComponent(url.pathname);
	const liveReload = sseClients !== undefined;

	if (pathname === '/__events' && sseClients) {
		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive',
		});
		res.write(':ok\n\n');
		sseClients.add(res);
		req.on('close', () => sseClients.delete(res));
		return;
	}

	if (pathname === '/') {
		res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
		res.end(renderIndex(ctx.directory.files, liveReload));
		return;
	}

	// Serve CSS file
	if (pathname === '/css/styles.css') {
		if (!ctx.cssPath) {
			res.writeHead(404, { 'Content-Type': 'text/plain' });
			res.end('No stylesheet configured');
			return;
		}
		try {
			const content = await fs.readFile(ctx.cssPath, 'utf-8');
			res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
			res.end(content);
		} catch {
			res.writeHead(404, { 'Content-Type': 'text/plain' });
			res.end('Stylesheet not found');
		}
		return;
	}

	// Match /preview/<file>/<partial>
	const match = pathname.match(/^\/preview\/(.+?)\/([^/]+)$/);
	if (!match) {
		res.writeHead(404, { 'Content-Type': 'text/plain' });
		res.end('Not found');
		return;
	}

	const [, filePath, partialName] = match;
	const compiledFile = ctx.directory.files.get(filePath);
	if (!compiledFile) {
		res.writeHead(404, { 'Content-Type': 'text/plain' });
		res.end(`File not found: ${filePath}`);
		return;
	}

	if (!compiledFile.partials.has(partialName)) {
		res.writeHead(404, { 'Content-Type': 'text/plain' });
		res.end(`Partial not found: ${partialName} in ${filePath}`);
		return;
	}

	const result = await previewPartial({
		partialName,
		compiledFile,
		fileName: filePath,
		allFiles: ctx.directory.files,
		cssHref: ctx.cssPath ? '/css/styles.css' : undefined,
		liveReload,
	});

	if (result.errors.length > 0) {
		for (const err of result.errors) console.error(err);
	}

	res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
	res.end(result.html);
}

/** Create and return the HTTP server (does not start listening). */
export function createServer(ctx: ServerContext, sseClients?: Set<http.ServerResponse>): http.Server {
	return http.createServer((req, res) => {
		handleRequest(req, res, ctx, sseClients).catch(err => {
			console.error(err);
			res.writeHead(500, { 'Content-Type': 'text/plain' });
			res.end('Internal server error');
		});
	});
}

/** Print all network addresses the server is reachable on. */
function printListeningAddresses(server: http.Server): void {
	const addr = server.address();
	if (!addr || typeof addr === 'string') {
		console.log(addr ?? 'unknown address');
		return;
	}
	const { port } = addr;

	// If bound to a specific interface, just print that.
	if (addr.address !== '::' && addr.address !== '0.0.0.0') {
		const host = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
		console.log(`  http://${host}:${port}`);
		return;
	}

	// Listening on all interfaces — enumerate them.
	const ifaces = os.networkInterfaces();
	for (const [, entries] of Object.entries(ifaces)) {
		if (!entries) continue;
		for (const entry of entries) {
			if (entry.internal) continue;
			const host = entry.family === 'IPv6' ? `[${entry.address}]` : entry.address;
			console.log(`  http://${host}:${port}`);
		}
	}
	console.log(`  http://localhost:${port}`);
}

// --- CLI entry point ---
if (import.meta.url === `file://${process.argv[1]}` ||
	process.argv[1]?.endsWith('/preview/server.ts') ||
	process.argv[1]?.endsWith('/preview/server.js')) {
	const portArg = process.argv.indexOf('--port');
	const port = portArg !== -1 ? parseInt(process.argv[portArg + 1], 10) : 3000;

	console.log('Compiling templates...');
	let ctx = await buildContext(process.cwd());
	const fileCount = ctx.directory.files.size;
	let partialCount = 0;
	for (const [, f] of ctx.directory.files) partialCount += f.partials.size;

	const sseClients = new Set<http.ServerResponse>();

	// Use a proxy so the http handler always sees the latest ctx after recompilation.
	const liveCtx: ServerContext = {
		get directory() { return ctx.directory; },
		get cssPath() { return ctx.cssPath; },
		get templateRoot() { return ctx.templateRoot; },
	};

	const server = createServer(liveCtx, sseClients);
	server.listen(port, () => {
		console.log(`Serving ${partialCount} partials from ${fileCount} files`);
		printListeningAddresses(server);
	});

	const projectDir = process.cwd();
	const configPath = path.join(projectDir, 'backflip.json');

	createWatcher({
		templateRoot: ctx.templateRoot,
		cssPath: ctx.cssPath || undefined,
		configPath,
	}, async (category) => {
		if (category === 'template' || category === 'config') {
			try {
				console.log('Recompiling templates...');
				ctx = await buildContext(projectDir);
				console.log('Recompilation complete.');
			} catch (err) {
				console.error('Recompilation failed:', err instanceof Error ? err.message : err);
			}
		}
		broadcastReload(sseClients);
	});
}
