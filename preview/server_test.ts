import { assertEquals, assertStringIncludes } from "@std/assert";
import { compileDirectory } from "../compiler/partials.ts";
import { renderIndex, handleRequest, type ServerContext } from "./server.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

const TEMPLATES_DIR = new URL("../test/templates", import.meta.url).pathname;

// Compile once for all tests
const { directory } = await compileDirectory(TEMPLATES_DIR);
const ctx: ServerContext = { directory, cssContent: '' };

// --- Minimal mock for http.IncomingMessage / http.ServerResponse ---

function mockReq(url: string): IncomingMessage {
	return { url, headers: { host: 'localhost:3000' } } as unknown as IncomingMessage;
}

function mockRes(): ServerResponse & { _status: number; _headers: Record<string, string>; _body: string } {
	const res = {
		_status: 0,
		_headers: {} as Record<string, string>,
		_body: '',
		writeHead(status: number, headers?: Record<string, string>) {
			res._status = status;
			if (headers) Object.assign(res._headers, headers);
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

// --- CSS injection ---

Deno.test("preview includes CSS when provided in context", async () => {
	const ctxWithCss: ServerContext = { directory, cssContent: 'body { color: blue; }' };
	const res = mockRes();
	await handleRequest(mockReq('/preview/simple.html/greeting'), res, ctxWithCss);
	assertEquals(res._status, 200);
	assertStringIncludes(res._body, 'body { color: blue; }');
});
