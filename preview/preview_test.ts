import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { compileDirectory } from "../compiler/partials.ts";
import { previewPartial } from "./preview.ts";

const TEMPLATES_DIR = new URL("../test/templates", import.meta.url).pathname;
const TMPDIR = "/tmp/claude-1000/preview-test-output";

// Compile once for all tests
const { directory: compiled } = await compileDirectory(TEMPLATES_DIR);

// Helper to get a CompiledFile by filename
function getFile(filename: string) {
	const file = compiled.files.get(filename);
	if (!file) throw new Error(`File not compiled: ${filename}`);
	return file;
}

// Helper for all files map
function allFiles() {
	return compiled.files;
}

// --- Basic preview ---

Deno.test("preview simple partial with printed variable", async () => {
	const result = await previewPartial({
		partialName: 'greeting',
		compiledFile: getFile('simple.html'),
		fileName: 'simple.html',
	});
	assertEquals(result.errors.length, 0);
	assertStringIncludes(result.html, 'name');
	assertStringIncludes(result.html, 'Hello,');
	assertEquals(result.mockData.name, 'name');
});

// --- b-for ---

Deno.test("preview partial with b-for generates repeated items", async () => {
	const result = await previewPartial({
		partialName: 'post-list',
		compiledFile: getFile('blog.html'),
		fileName: 'blog.html',
	});
	assertEquals(result.errors.length, 0);
	assertStringIncludes(result.html, '<li>');
	assertStringIncludes(result.html, 'posts 1');
	assertStringIncludes(result.html, 'posts 2');
	assertStringIncludes(result.html, 'posts 3');
});

// --- b-if ---

Deno.test("preview partial with b-if shows truthy branch", async () => {
	const result = await previewPartial({
		partialName: 'conditional',
		compiledFile: getFile('blog.html'),
		fileName: 'blog.html',
	});
	assertEquals(result.errors.length, 0);
	assertStringIncludes(result.html, 'Shown');
});

// --- Slots ---

Deno.test("preview partial with slot shows placeholder", async () => {
	const result = await previewPartial({
		partialName: 'btn',
		compiledFile: getFile('ui.html'),
		fileName: 'ui.html',
	});
	assertEquals(result.errors.length, 0);
	assertStringIncludes(result.html, 'default content');
	assertStringIncludes(result.html, '<button>');
});

// --- Nested b-part (same-file) ---

Deno.test("preview partial that references another same-file partial via b-part", async () => {
	// 'demo' in ui.html calls 'btn' with slot content "Click me"
	const result = await previewPartial({
		partialName: 'demo',
		compiledFile: getFile('ui.html'),
		fileName: 'ui.html',
	});
	assertEquals(result.errors.length, 0);
	assertStringIncludes(result.html, 'Click me');
	assertStringIncludes(result.html, '<button>');
});

// --- Nested b-part with data binding ---

Deno.test("preview partial that passes data to child via b-data", async () => {
	// 'profile' in data.html calls 'badge' with b-data:label="user.name"
	// badge uses {{ label }}, so the mock data for 'user' should have .name
	const result = await previewPartial({
		partialName: 'profile',
		compiledFile: getFile('data.html'),
		fileName: 'data.html',
	});
	assertEquals(result.errors.length, 0);
	// The rendered HTML should contain the mock value for user.name
	// which gets passed as 'label' to badge and printed
	assertStringIncludes(result.html, 'name');
	// Verify mock data has the right structure
	const user = result.mockData.user as Record<string, unknown>;
	assertEquals(typeof user, 'object');
	assertEquals(typeof user.name, 'string');
});

// --- Cross-file b-part ---

Deno.test("preview partial with cross-file reference", async () => {
	// 'labeled' in page.html calls components.html#label with b-data:text="msg"
	const result = await previewPartial({
		partialName: 'labeled',
		compiledFile: getFile('page.html'),
		fileName: 'page.html',
		allFiles: allFiles(),
		tmpDir: TMPDIR,
	});
	assertEquals(result.errors.length, 0);
	// msg is passed to label as 'text', and label prints {{ text }}
	assertStringIncludes(result.html, 'msg');
});

Deno.test("preview cross-file partial with slot content", async () => {
	// 'boxed' in page.html calls components.html#box and fills default slot with <span>Hi</span>
	const result = await previewPartial({
		partialName: 'boxed',
		compiledFile: getFile('page.html'),
		fileName: 'page.html',
		allFiles: allFiles(),
		tmpDir: TMPDIR,
	});
	assertEquals(result.errors.length, 0);
	assertStringIncludes(result.html, 'Hi');
	assertStringIncludes(result.html, 'class="box"');
});

// --- CSS injection ---

Deno.test("preview with CSS includes stylesheet in output", async () => {
	const result = await previewPartial({
		partialName: 'greeting',
		compiledFile: getFile('simple.html'),
		fileName: 'simple.html',
		cssContent: 'p { color: red; }',
	});
	assertStringIncludes(result.html, 'p { color: red; }');
});

// --- Preview chrome ---

Deno.test("preview wraps in HTML document with partial name", async () => {
	const result = await previewPartial({
		partialName: 'greeting',
		compiledFile: getFile('simple.html'),
		fileName: 'simple.html',
	});
	assertStringIncludes(result.html, '<!DOCTYPE html>');
	assertStringIncludes(result.html, 'Preview:');
	assertStringIncludes(result.html, 'greeting');
});

// --- Data overrides ---

Deno.test("preview with data overrides uses custom values", async () => {
	const result = await previewPartial({
		partialName: 'greeting',
		compiledFile: getFile('simple.html'),
		fileName: 'simple.html',
		dataOverrides: { name: 'World' },
	});
	assertEquals(result.errors.length, 0);
	assertStringIncludes(result.html, 'World');
});

// --- Error handling ---

Deno.test("preview nonexistent partial returns error", async () => {
	const result = await previewPartial({
		partialName: 'nonexistent',
		compiledFile: getFile('simple.html'),
		fileName: 'simple.html',
	});
	assertEquals(result.errors.length, 1);
	assertStringIncludes(result.errors[0], 'not found');
});
