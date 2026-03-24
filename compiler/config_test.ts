import { assertEquals, assertRejects } from "jsr:@std/assert";
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { loadConfig, resolveConfigRoot, CONFIG_FILENAME } from './config.ts';

const TMPDIR = '/tmp/claude-1000/';

async function makeTempDir(suffix: string): Promise<string> {
	const dir = path.join(TMPDIR, `config_test_${suffix}_${Date.now()}`);
	await fs.mkdir(dir, { recursive: true });
	return dir;
}

Deno.test("loadConfig - returns null when no config file exists", async () => {
	const dir = await makeTempDir("missing");
	const result = await loadConfig(dir);
	assertEquals(result, null);
});

Deno.test("loadConfig - returns parsed config with root only", async () => {
	const dir = await makeTempDir("root_only");
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({ root: "src/templates" }));
	const result = await loadConfig(dir);
	assertEquals(result, { root: "src/templates" });
});

Deno.test("loadConfig - returns parsed config with all fields", async () => {
	const dir = await makeTempDir("all_fields");
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
		root: "src/templates",
		output: "dist",
		lang: "js"
	}));
	const result = await loadConfig(dir);
	assertEquals(result, { root: "src/templates", output: "dist", lang: "js" });
});

Deno.test("loadConfig - accepts lang php", async () => {
	const dir = await makeTempDir("lang_php");
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({ root: ".", lang: "php" }));
	const result = await loadConfig(dir);
	assertEquals(result, { root: ".", lang: "php" });
});

Deno.test("loadConfig - throws on invalid JSON", async () => {
	const dir = await makeTempDir("bad_json");
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), "not json{");
	await assertRejects(() => loadConfig(dir), Error, "Invalid JSON");
});

Deno.test("loadConfig - throws when root is missing", async () => {
	const dir = await makeTempDir("no_root");
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({ output: "dist" }));
	await assertRejects(() => loadConfig(dir), Error, '"root" is required');
});

Deno.test("loadConfig - throws when root is not a string", async () => {
	const dir = await makeTempDir("root_num");
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({ root: 123 }));
	await assertRejects(() => loadConfig(dir), Error, '"root" is required and must be a string');
});

Deno.test("loadConfig - throws on invalid lang value", async () => {
	const dir = await makeTempDir("bad_lang");
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({ root: ".", lang: "python" }));
	await assertRejects(() => loadConfig(dir), Error, '"lang" must be "js" or "php"');
});

Deno.test("loadConfig - throws when config is not an object", async () => {
	const dir = await makeTempDir("array");
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify([1, 2, 3]));
	await assertRejects(() => loadConfig(dir), Error, "must be a JSON object");
});

Deno.test("loadConfig - returns parsed config with stylesheet", async () => {
	const dir = await makeTempDir("stylesheet");
	await fs.writeFile(path.join(dir, "styles.css"), "body { margin: 0; }");
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
		root: ".",
		stylesheet: "styles.css"
	}));
	const result = await loadConfig(dir);
	assertEquals(result, { root: ".", stylesheet: "styles.css" });
});

Deno.test("loadConfig - throws when stylesheet is not a string", async () => {
	const dir = await makeTempDir("stylesheet_num");
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({ root: ".", stylesheet: 123 }));
	await assertRejects(() => loadConfig(dir), Error, '"stylesheet" must be a string');
});

Deno.test("loadConfig - throws when stylesheet file does not exist", async () => {
	const dir = await makeTempDir("stylesheet_missing");
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({ root: ".", stylesheet: "missing.css" }));
	await assertRejects(() => loadConfig(dir), Error, 'stylesheet not found: missing.css');
});

Deno.test("resolveConfigRoot - resolves relative path", () => {
	const result = resolveConfigRoot("/home/user/project", { root: "src/templates" });
	assertEquals(result, "/home/user/project/src/templates");
});

Deno.test("resolveConfigRoot - resolves dot to config dir", () => {
	const result = resolveConfigRoot("/home/user/project", { root: "." });
	assertEquals(result, "/home/user/project");
});

Deno.test("resolveConfigRoot - resolves absolute path as-is", () => {
	const result = resolveConfigRoot("/home/user/project", { root: "/other/path" });
	assertEquals(result, "/other/path");
});
