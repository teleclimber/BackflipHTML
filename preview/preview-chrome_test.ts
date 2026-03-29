import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { wrapInChrome } from "./preview-chrome.ts";

Deno.test("fragment: wraps in full document with banner", () => {
	const html = wrapInChrome('<div>hello</div>', 'card', { fileName: 'ui.html' });
	assertStringIncludes(html, '<!DOCTYPE html>');
	assertStringIncludes(html, '<head>');
	assertStringIncludes(html, '<body>');
	assertStringIncludes(html, 'backflip-preview-bar');
	assertStringIncludes(html, 'ui.html');
	assertStringIncludes(html, 'card');
});

Deno.test("fragment: banner without fileName shows partial name only", () => {
	const html = wrapInChrome('<div>hello</div>', 'card');
	assertStringIncludes(html, 'card');
	assertEquals(html.includes('&rsaquo;'), false);
});

Deno.test("document-level: no banner, doctype prepended, single head/body", () => {
	const input = '<html><head><title>Hi</title></head><body><p>content</p></body></html>';
	const html = wrapInChrome(input, 'page');
	assertEquals(html.startsWith('<!DOCTYPE html>'), true);
	assertEquals(html.includes('backflip-preview-bar'), false);
	const headCount = (html.match(/<head[\s>]/gi) || []).length;
	const bodyCount = (html.match(/<body[\s>]/gi) || []).length;
	assertEquals(headCount, 1, 'should have exactly one <head>');
	assertEquals(bodyCount, 1, 'should have exactly one <body>');
});

Deno.test("document-level: injects styles into head", () => {
	const input = '<html><head><title>Hi</title></head><body></body></html>';
	const html = wrapInChrome(input, 'page', { cssHref: '/css/app.css' });
	assertStringIncludes(html, '<link rel="stylesheet" href="/css/app.css">');
	// CSS link should be inside <head>
	const headEnd = html.indexOf('</head>');
	const linkPos = html.indexOf('/css/app.css');
	assertEquals(linkPos < headEnd, true, 'CSS link should be inside <head>');
});

Deno.test("html with only <body> (no <head>) gets fragment wrapping", () => {
	const html = wrapInChrome('<body><p>content</p></body>', 'test');
	assertStringIncludes(html, 'backflip-preview-bar');
});

// --- Live reload script injection ---

Deno.test("fragment: includes reload script when liveReload is true", () => {
	const html = wrapInChrome('<div>hello</div>', 'card', { liveReload: true });
	assertStringIncludes(html, 'EventSource');
	assertStringIncludes(html, '/__events');
});

Deno.test("fragment: omits reload script when liveReload is false", () => {
	const html = wrapInChrome('<div>hello</div>', 'card', { liveReload: false });
	assertEquals(html.includes('EventSource'), false);
});

Deno.test("fragment: omits reload script by default", () => {
	const html = wrapInChrome('<div>hello</div>', 'card');
	assertEquals(html.includes('EventSource'), false);
});

Deno.test("document-level: includes reload script when liveReload is true", () => {
	const input = '<html><head><title>Hi</title></head><body><p>content</p></body></html>';
	const html = wrapInChrome(input, 'page', { liveReload: true });
	assertStringIncludes(html, 'EventSource');
	// Script should be before </body>
	const scriptPos = html.indexOf('EventSource');
	const bodyEnd = html.indexOf('</body>');
	assertEquals(scriptPos < bodyEnd, true, 'reload script should be before </body>');
});

Deno.test("document-level: omits reload script by default", () => {
	const input = '<html><head><title>Hi</title></head><body><p>content</p></body></html>';
	const html = wrapInChrome(input, 'page');
	assertEquals(html.includes('EventSource'), false);
});
