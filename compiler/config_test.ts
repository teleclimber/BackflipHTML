import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert";
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { loadConfig, resolveConfigRoot, resolveAssetDirs, resolveDomPatchOutputDirs, CONFIG_FILENAME, type BackflipConfig } from './config.ts';

const TMPDIR = '/tmp/claude-1000/';

async function makeTempDir(suffix: string): Promise<string> {
	const dir = path.join(TMPDIR, `config_test_${suffix}_${Date.now()}`);
	await fs.mkdir(dir, { recursive: true });
	return dir;
}

Deno.test("resolveDomPatchOutputDirs - returns absolute dom-patch output dirs only", () => {
	const config: BackflipConfig = {
		root: "templates",
		output: [
			{ lang: "dom-patch", path: "server/static/bfdom/" },
			{ lang: "js", path: "server/compiled" },
		],
		assets: [
			{ name: "assets", path: "server/static/", prefix: "/static/" },
		],
	};
	assertEquals(resolveDomPatchOutputDirs("/proj", config), ["/proj/server/static/bfdom"]);
});

Deno.test("resolveDomPatchOutputDirs - empty when no dom-patch output", () => {
	const config: BackflipConfig = {
		root: "templates",
		output: [{ lang: "js", path: "dist" }],
	};
	assertEquals(resolveDomPatchOutputDirs("/proj", config), []);
});

Deno.test("loadConfig - returns null when no config file exists", async () => {
	const dir = await makeTempDir("missing");
	const { config, errors } = await loadConfig(dir);
	assertEquals(config, null);
	assertEquals(errors, []);
});

Deno.test("loadConfig - returns parsed config with root only", async () => {
	const dir = await makeTempDir("root_only");
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({ root: "src/templates" }));
	const { config, errors } = await loadConfig(dir);
	assertEquals(config, { root: "src/templates" });
	assertEquals(errors, []);
});

Deno.test("loadConfig - returns parsed config with all fields", async () => {
	const dir = await makeTempDir("all_fields");
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
		root: "src/templates",
		output: [{ lang: "js", path: "dist" }]
	}));
	const { config, errors } = await loadConfig(dir);
	assertEquals(config, { root: "src/templates", output: [{ lang: "js", path: "dist" }] });
	assertEquals(errors, []);
});

Deno.test("loadConfig - accepts multiple output entries", async () => {
	const dir = await makeTempDir("multi_output");
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
		root: ".",
		output: [
			{ lang: "js", path: "dist/js" },
			{ lang: "php", path: "dist/php" }
		]
	}));
	const { config, errors } = await loadConfig(dir);
	assertEquals(config, {
		root: ".",
		output: [
			{ lang: "js", path: "dist/js" },
			{ lang: "php", path: "dist/php" }
		]
	});
	assertEquals(errors, []);
});

Deno.test("loadConfig - accepts output with lang php", async () => {
	const dir = await makeTempDir("lang_php");
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
		root: ".",
		output: [{ lang: "php", path: "out" }]
	}));
	const { config, errors } = await loadConfig(dir);
	assertEquals(config, { root: ".", output: [{ lang: "php", path: "out" }] });
	assertEquals(errors, []);
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

Deno.test("loadConfig - throws on invalid output lang value", async () => {
	const dir = await makeTempDir("bad_lang");
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
		root: ".", output: [{ lang: "python", path: "dist" }]
	}));
	await assertRejects(() => loadConfig(dir), Error, 'output[0].lang must be "js", "php", or "dom-patch"');
});

Deno.test("loadConfig - throws when output is not an array", async () => {
	const dir = await makeTempDir("output_str");
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({ root: ".", output: "dist" }));
	await assertRejects(() => loadConfig(dir), Error, '"output" must be an array');
});

Deno.test("loadConfig - throws when output entry missing path", async () => {
	const dir = await makeTempDir("output_no_path");
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
		root: ".", output: [{ lang: "js" }]
	}));
	await assertRejects(() => loadConfig(dir), Error, 'output[0].path must be a string');
});

Deno.test("loadConfig - throws on duplicate output paths", async () => {
	const dir = await makeTempDir("output_dup");
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
		root: ".", output: [
			{ lang: "js", path: "dist" },
			{ lang: "php", path: "dist" }
		]
	}));
	await assertRejects(() => loadConfig(dir), Error, 'duplicate output path "dist"');
});

Deno.test("loadConfig - throws when legacy top-level lang is used", async () => {
	const dir = await makeTempDir("legacy_lang");
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({ root: ".", lang: "js" }));
	await assertRejects(() => loadConfig(dir), Error, '"lang" is no longer supported');
});

Deno.test("loadConfig - throws when config is not an object", async () => {
	const dir = await makeTempDir("array");
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify([1, 2, 3]));
	await assertRejects(() => loadConfig(dir), Error, "must be a JSON object");
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

// --- assets config tests ---

Deno.test("loadConfig - returns parsed config with valid assets", async () => {
	const dir = await makeTempDir("assets_valid");
	await fs.mkdir(path.join(dir, "images"), { recursive: true });
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
		root: ".",
		assets: [{ name: "images", path: "images", prefix: "/img/" }]
	}));
	const { config, errors } = await loadConfig(dir);
	assertEquals(config, {
		root: ".",
		assets: [{ name: "images", path: "images", prefix: "/img/" }]
	});
	assertEquals(errors, []);
});

Deno.test("loadConfig - accepts empty assets array", async () => {
	const dir = await makeTempDir("assets_empty");
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
		root: ".", assets: []
	}));
	const { config, errors } = await loadConfig(dir);
	assertEquals(config, { root: "." });
	assertEquals(errors, []);
});

Deno.test("loadConfig - accepts multiple asset dirs", async () => {
	const dir = await makeTempDir("assets_multi");
	await fs.mkdir(path.join(dir, "images"), { recursive: true });
	await fs.mkdir(path.join(dir, "icons"), { recursive: true });
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
		root: ".",
		assets: [
			{ name: "images", path: "images", prefix: "/img/" },
			{ name: "icons", path: "icons", prefix: "https://cdn.example.com/icons/" }
		]
	}));
	const { config, errors } = await loadConfig(dir);
	assertEquals(config!.assets!.length, 2);
	assertEquals(config!.assets![0].name, "images");
	assertEquals(config!.assets![1].name, "icons");
	assertEquals(errors, []);
});

Deno.test("loadConfig - throws when assets is not an array", async () => {
	const dir = await makeTempDir("assets_notarr");
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
		root: ".", assets: "nope"
	}));
	await assertRejects(() => loadConfig(dir), Error, '"assets" must be an array');
});

Deno.test("loadConfig - throws when asset entry is not an object", async () => {
	const dir = await makeTempDir("assets_badentry");
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
		root: ".", assets: ["bad"]
	}));
	await assertRejects(() => loadConfig(dir), Error, 'assets[0] must be an object');
});

Deno.test("loadConfig - throws when asset name has invalid characters", async () => {
	const dir = await makeTempDir("assets_badname");
	await fs.mkdir(path.join(dir, "imgs"), { recursive: true });
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
		root: ".", assets: [{ name: "my images!", path: "imgs", prefix: "/" }]
	}));
	await assertRejects(() => loadConfig(dir), Error, 'alphanumeric with dashes and underscores only');
});

Deno.test("loadConfig - throws when asset name contains slashes", async () => {
	const dir = await makeTempDir("assets_slashname");
	await fs.mkdir(path.join(dir, "imgs"), { recursive: true });
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
		root: ".", assets: [{ name: "my/images", path: "imgs", prefix: "/" }]
	}));
	await assertRejects(() => loadConfig(dir), Error, 'alphanumeric with dashes and underscores only');
});

Deno.test("loadConfig - throws on duplicate asset names", async () => {
	const dir = await makeTempDir("assets_dup");
	await fs.mkdir(path.join(dir, "a"), { recursive: true });
	await fs.mkdir(path.join(dir, "b"), { recursive: true });
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
		root: ".", assets: [
			{ name: "imgs", path: "a", prefix: "/" },
			{ name: "imgs", path: "b", prefix: "/" }
		]
	}));
	await assertRejects(() => loadConfig(dir), Error, 'duplicate asset name "imgs"');
});

Deno.test("loadConfig - throws when asset path escapes project directory", async () => {
	const dir = await makeTempDir("assets_escape");
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
		root: ".", assets: [{ name: "imgs", path: "../../etc", prefix: "/" }]
	}));
	await assertRejects(() => loadConfig(dir), Error, 'must not escape the project directory');
});

Deno.test("loadConfig - asset path not found is a soft error", async () => {
	const dir = await makeTempDir("assets_nodir");
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
		root: ".", assets: [{ name: "imgs", path: "nonexistent", prefix: "/" }]
	}));
	const { config, errors } = await loadConfig(dir);
	assertEquals(config!.assets!.length, 1);
	assertEquals(config!.assets![0].name, "imgs");
	assertEquals(config!.assets![0].path, "nonexistent");
	assertEquals(config!.assets![0].prefix, "/");
	assertEquals(errors.length, 1);
	assertStringIncludes(errors[0], 'directory not found: nonexistent');
});

Deno.test("loadConfig - asset path is file not directory is a soft error", async () => {
	const dir = await makeTempDir("assets_file");
	await fs.writeFile(path.join(dir, "afile.txt"), "hello");
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
		root: ".", assets: [{ name: "imgs", path: "afile.txt", prefix: "/" }]
	}));
	const { config, errors } = await loadConfig(dir);
	assertEquals(config!.assets!.length, 1);
	assertEquals(config!.assets![0].name, "imgs");
	assertEquals(errors.length, 1);
	assertStringIncludes(errors[0], 'is not a directory');
});

Deno.test("loadConfig - asset path error does not block other assets", async () => {
	const dir = await makeTempDir("assets_mixed");
	await fs.mkdir(path.join(dir, "images"), { recursive: true });
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
		root: ".",
		assets: [
			{ name: "images", path: "images", prefix: "/img/" },
			{ name: "missing", path: "nope", prefix: "/m/" },
			{ name: "also-missing", path: "gone", prefix: "/g/" }
		]
	}));
	const { config, errors } = await loadConfig(dir);
	assertEquals(config!.assets!.length, 3);
	assertEquals(config!.assets![0].name, "images");
	assertEquals(config!.assets![1].name, "missing");
	assertEquals(config!.assets![2].name, "also-missing");
	assertEquals(errors.length, 2);
	assertStringIncludes(errors[0], 'nope');
	assertStringIncludes(errors[1], 'gone');
});

Deno.test("loadConfig - throws when asset prefix missing trailing slash", async () => {
	const dir = await makeTempDir("assets_noslash");
	await fs.mkdir(path.join(dir, "images"), { recursive: true });
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
		root: ".", assets: [{ name: "imgs", path: "images", prefix: "images" }]
	}));
	await assertRejects(() => loadConfig(dir), Error, 'prefix must end with "/"');
});

Deno.test("loadConfig - throws when asset prefix is not a string", async () => {
	const dir = await makeTempDir("assets_badprefix");
	await fs.mkdir(path.join(dir, "images"), { recursive: true });
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
		root: ".", assets: [{ name: "imgs", path: "images", prefix: 123 }]
	}));
	await assertRejects(() => loadConfig(dir), Error, 'prefix must be a string');
});

Deno.test("loadConfig - throws when asset path is not a string", async () => {
	const dir = await makeTempDir("assets_badpath");
	await fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify({
		root: ".", assets: [{ name: "imgs", path: 123, prefix: "/" }]
	}));
	await assertRejects(() => loadConfig(dir), Error, 'path must be a string');
});

// --- resolveAssetDirs tests ---

Deno.test("resolveAssetDirs - resolves asset paths to absolute", () => {
	const result = resolveAssetDirs("/home/user/project", {
		root: ".",
		assets: [
			{ name: "images", path: "assets/images", prefix: "/img/" },
			{ name: "icons", path: "icons", prefix: "/icons/" }
		]
	});
	assertEquals(result.get("images"), "/home/user/project/assets/images");
	assertEquals(result.get("icons"), "/home/user/project/icons");
});

Deno.test("resolveAssetDirs - returns empty map when no assets", () => {
	const result = resolveAssetDirs("/home/user/project", { root: "." });
	assertEquals(result.size, 0);
});
