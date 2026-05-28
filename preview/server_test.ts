import { assertEquals, assertStringIncludes } from "@std/assert";
import { compileDirectory } from "../compiler/partials.ts";
import { compilePartial } from "../compiler/compiler.ts";
import type { CompiledFile, PartialDef } from "../compiler/types.ts";
import { renderIndex, handleRequest, broadcastReload, type ServerContext } from "./server.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";

const TEMPLATES_DIR = new URL("../test/templates", import.meta.url).pathname;

// Compile once for all tests
const { directory } = await compileDirectory(TEMPLATES_DIR);
const ctx: ServerContext = { directory, cssHrefs: [], templateRoot: TEMPLATES_DIR };

// --- Minimal mock for http.IncomingMessage / http.ServerResponse ---

function mockReq(url: string): IncomingMessage {
	return { url, headers: { host: 'localhost:3000' } } as unknown as IncomingMessage;
}

function mockRes(): ServerResponse & { _status: number; _headers: Record<string, string>; _body: string; _written: string } {
	const res = {
		_status: 0,
		_headers: {} as Record<string, string>,
		_body: '',
		_written: '',
		writeHead(status: number, headers?: Record<string, string>) {
			res._status = status;
			if (headers) Object.assign(res._headers, headers);
		},
		write(chunk: string) {
			res._written += chunk;
			return true;
		},
		end(body?: string) {
			res._body = body ?? '';
		},
	};
	return res as any;
}

// --- Index page ---

Deno.test("index page lists all files and partials", () => {
	const html = renderIndex(ctx.directory.files);
	assertStringIncludes(html, 'Backflip Previews');
	assertStringIncludes(html, 'simple.html');
	assertStringIncludes(html, 'greeting');
	assertStringIncludes(html, '/preview/');
});

Deno.test("index page links are properly encoded", () => {
	const html = renderIndex(ctx.directory.files);
	assertStringIncludes(html, 'href="/preview/');
});

// --- GET / ---

Deno.test("GET / returns index page", async () => {
	const res = mockRes();
	await handleRequest(mockReq('/'), res, ctx);
	assertEquals(res._status, 200);
	assertStringIncludes(res._headers['Content-Type'], 'text/html');
	assertStringIncludes(res._body, 'Backflip Previews');
});

// --- GET /preview/:file/:partial ---

Deno.test("GET /preview/:file/:partial returns rendered preview", async () => {
	const res = mockRes();
	await handleRequest(mockReq('/preview/simple.html/greeting'), res, ctx);
	assertEquals(res._status, 200);
	assertStringIncludes(res._headers['Content-Type'], 'text/html');
	assertStringIncludes(res._body, '<!DOCTYPE html>');
	assertStringIncludes(res._body, 'Hello,');
	assertStringIncludes(res._body, 'greeting');
});

Deno.test("GET /preview/:file/:partial returns 404 for unknown file", async () => {
	const res = mockRes();
	await handleRequest(mockReq('/preview/nope.html/foo'), res, ctx);
	assertEquals(res._status, 404);
	assertStringIncludes(res._body, 'File not found');
});

Deno.test("GET /preview/:file/:partial returns 404 for unknown partial", async () => {
	const res = mockRes();
	await handleRequest(mockReq('/preview/simple.html/nonexistent'), res, ctx);
	assertEquals(res._status, 404);
	assertStringIncludes(res._body, 'Partial not found');
});

Deno.test("GET unknown route returns 404", async () => {
	const res = mockRes();
	await handleRequest(mockReq('/something/else'), res, ctx);
	assertEquals(res._status, 404);
});

// --- CSS from asset dirs ---

Deno.test("preview includes CSS links when cssHrefs are set", async () => {
	const ctxWithCss: ServerContext = { directory, cssHrefs: ['/__assets/styles/main.css', '/__assets/styles/theme.css'], templateRoot: TEMPLATES_DIR };
	const res = mockRes();
	await handleRequest(mockReq('/preview/simple.html/greeting'), res, ctxWithCss);
	assertEquals(res._status, 200);
	assertStringIncludes(res._body, '<link rel="stylesheet" href="/__assets/styles/main.css">');
	assertStringIncludes(res._body, '<link rel="stylesheet" href="/__assets/styles/theme.css">');
});

// --- SSE and live reload ---

Deno.test("GET /__events returns SSE stream when sseClients provided", async () => {
	const sseClients = new Set<any>();
	const req = mockReq('/__events');
	const closeHandlers: (() => void)[] = [];
	(req as any).on = (event: string, handler: () => void) => {
		if (event === 'close') closeHandlers.push(handler);
	};
	const res = mockRes();
	await handleRequest(req, res, ctx, sseClients);
	assertEquals(res._status, 200);
	assertStringIncludes(res._headers['Content-Type'], 'text/event-stream');
	assertStringIncludes(res._written, ':ok');
	assertEquals(sseClients.size, 1);
	// Simulate disconnect
	closeHandlers[0]();
	assertEquals(sseClients.size, 0);
});

Deno.test("GET /__events returns 404 without sseClients", async () => {
	const res = mockRes();
	await handleRequest(mockReq('/__events'), res, ctx);
	assertEquals(res._status, 404);
});

Deno.test("broadcastReload sends event to all clients", () => {
	const written: string[] = [];
	const clients = new Set<any>([
		{ write(s: string) { written.push(s); return true; } },
		{ write(s: string) { written.push(s); return true; } },
	]);
	broadcastReload(clients);
	assertEquals(written.length, 2);
	for (const msg of written) {
		assertStringIncludes(msg, 'event: reload');
		assertStringIncludes(msg, 'data: {}');
	}
});

Deno.test("preview includes reload script when sseClients provided", async () => {
	const sseClients = new Set<any>();
	const res = mockRes();
	await handleRequest(mockReq('/preview/simple.html/greeting'), res, ctx, sseClients);
	assertEquals(res._status, 200);
	assertStringIncludes(res._body, 'EventSource');
	assertStringIncludes(res._body, '/__events');
});

Deno.test("preview omits reload script without sseClients", async () => {
	const res = mockRes();
	await handleRequest(mockReq('/preview/simple.html/greeting'), res, ctx);
	assertEquals(res._status, 200);
	assertEquals(res._body.includes('EventSource'), false);
});

Deno.test("index page includes reload script when sseClients provided", async () => {
	const sseClients = new Set<any>();
	const res = mockRes();
	await handleRequest(mockReq('/'), res, ctx, sseClients);
	assertEquals(res._status, 200);
	assertStringIncludes(res._body, 'EventSource');
});

Deno.test("responses include Cache-Control: no-store", async () => {
	const res = mockRes();
	await handleRequest(mockReq('/preview/simple.html/greeting'), res, ctx);
	assertEquals(res._headers['Cache-Control'], 'no-store');
});

// --- dom-patch asset interception ---

async function compileCustomElement(html: string): Promise<CompiledFile> {
	const m = html.match(/<([a-z][a-z0-9-]*-[a-z0-9-]*)/);
	if (!m) throw new Error('test html must start with a custom-element tag');
	const def: PartialDef = { name: m[1], exported: false, customElement: true, loc: { filename: '', from: 1, to: 1 } };
	const { compiled, errors } = await compilePartial(html, def);
	if (errors.length > 0) throw new Error('compile errors: ' + errors.map(e => e.message).join(', '));
	return { partials: new Map([[def.name, compiled]]) };
}

Deno.test("server serves generated dom-patch JS for a dom-patch dir nested inside an asset dir", async () => {
	const file = await compileCustomElement(
		`<my-badge b-attr:tone><span :data-tone="tone">badge</span></my-badge>`
	);
	const tmpDir = await Deno.makeTempDir({ prefix: 'srv-bfdom-' });
	// Asset dir is `static/`; dom-patch output goes to the `static/bfdom` SUBDIR.
	const assetDir = '/proj/server/static';
	const buildDir = path.join(assetDir, 'bfdom');
	const dpCtx: ServerContext = {
		directory: { files: new Map([['badge.html', file]]) },
		cssHrefs: [],
		templateRoot: '/templates',
		assetDirs: new Map([['static', assetDir]]),
		assetMap: new Map([['static', '/__assets/static/']]),
		domPatchOutputDirs: [buildDir],
		domPatchTmpDir: tmpDir,
		domPatchAssets: new Map(),
	};

	// Rendering the preview records build-dest -> saved-path for the generated JS.
	const previewRes = mockRes();
	await handleRequest(mockReq('/preview/badge.html/my-badge'), previewRes, dpCtx);
	assertEquals(previewRes._status, 200);
	const htmlBfid = previewRes._body.match(/data-bfid="([^"]+)"/)?.[1];
	assertEquals(typeof htmlBfid, 'string');
	// The map keys on the nested build destination, not the asset dir root.
	assertEquals(dpCtx.domPatchAssets!.has(path.join(buildDir, 'badge.js')), true);

	// A request resolving to that nested path is served the fresh JS (no disk read).
	const jsRes = mockRes();
	await handleRequest(mockReq('/__assets/static/bfdom/badge.js'), jsRes, dpCtx);
	assertEquals(jsRes._status, 200);
	assertStringIncludes(jsRes._headers['Content-Type'], 'javascript');
	const jsBfid = String(jsRes._body).match(/data-bfid="([^"]+)"/)?.[1];
	assertEquals(htmlBfid, jsBfid);
});

