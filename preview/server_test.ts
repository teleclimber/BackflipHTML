import { assertEquals, assertStringIncludes } from "@std/assert";
import { compileDirectory } from "../compiler/partials.ts";
import { renderIndex, handleRequest, broadcastReload, type ServerContext } from "./server.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

const TEMPLATES_DIR = new URL("../test/templates", import.meta.url).pathname;

// Compile once for all tests
const { directory } = await compileDirectory(TEMPLATES_DIR);
const ctx: ServerContext = { directory, cssPath: '', templateRoot: TEMPLATES_DIR };

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

// --- CSS serving ---

Deno.test("preview includes CSS link when cssPath is set", async () => {
	const ctxWithCss: ServerContext = { directory, cssPath: '/some/styles.css', templateRoot: TEMPLATES_DIR };
	const res = mockRes();
	await handleRequest(mockReq('/preview/simple.html/greeting'), res, ctxWithCss);
	assertEquals(res._status, 200);
	assertStringIncludes(res._body, '<link rel="stylesheet" href="/css/styles.css">');
});

Deno.test("GET /css/styles.css serves CSS file", async () => {
	const tmpCss = await Deno.makeTempFile({ suffix: '.css' });
	await Deno.writeTextFile(tmpCss, 'body { color: blue; }');
	try {
		const ctxWithCss: ServerContext = { directory, cssPath: tmpCss, templateRoot: TEMPLATES_DIR };
		const res = mockRes();
		await handleRequest(mockReq('/css/styles.css'), res, ctxWithCss);
		assertEquals(res._status, 200);
		assertStringIncludes(res._headers['Content-Type'], 'text/css');
		assertStringIncludes(res._body, 'body { color: blue; }');
	} finally {
		await Deno.remove(tmpCss).catch(() => {});
	}
});

Deno.test("GET /css/styles.css returns 404 when no stylesheet configured", async () => {
	const res = mockRes();
	await handleRequest(mockReq('/css/styles.css'), res, ctx);
	assertEquals(res._status, 404);
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

Deno.test("CSS response includes Cache-Control: no-store", async () => {
	const tmpCss = await Deno.makeTempFile({ suffix: '.css' });
	await Deno.writeTextFile(tmpCss, 'body { color: red; }');
	try {
		const ctxWithCss: ServerContext = { directory, cssPath: tmpCss, templateRoot: TEMPLATES_DIR };
		const res = mockRes();
		await handleRequest(mockReq('/css/styles.css'), res, ctxWithCss);
		assertEquals(res._headers['Cache-Control'], 'no-store');
	} finally {
		await Deno.remove(tmpCss).catch(() => {});
	}
});
