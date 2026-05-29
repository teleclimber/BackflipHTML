/**
 * CLI integration tests for output directory behavior.
 *
 * When the output directory comes from CLI arguments, the CLI should block
 * (exit 1) if the directory is not empty.
 *
 * When the output directory comes from the config file (backflip.json),
 * the CLI should auto-clean the directory before writing.
 */

import { assertEquals } from "jsr:@std/assert";
import * as path from "node:path";
import * as fs from "node:fs/promises";

const CLI_PATH = new URL("../cli.ts", import.meta.url).pathname;
const TEMPLATES_DIR = new URL("./templates", import.meta.url).pathname;
const ASSETS_DIR = new URL("./assets/images", import.meta.url).pathname;
const TMPDIR = "/tmp/claude-1000";

async function runCli(args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
    const cmd = new Deno.Command("deno", {
        args: ["run", "--allow-read", "--allow-write", CLI_PATH, ...args],
        cwd,
        stdout: "piped",
        stderr: "piped",
    });
    const output = await cmd.output();
    return {
        code: output.code,
        stdout: new TextDecoder().decode(output.stdout),
        stderr: new TextDecoder().decode(output.stderr),
    };
}

Deno.test("CLI args: blocks when output directory is not empty", async () => {
    const outDir = path.join(TMPDIR, "cli-test-block");
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, "existing.txt"), "hello");

    try {
        const { code, stderr } = await runCli([TEMPLATES_DIR, outDir, "--lang", "js"]);
        assertEquals(code, 1);
        assertEquals(stderr.includes("not empty"), true, `Expected 'not empty' in stderr: ${stderr}`);
    } finally {
        await fs.rm(outDir, { recursive: true, force: true });
    }
});

Deno.test("Config: auto-cleans output directory when not empty", async () => {
    const workDir = path.join(TMPDIR, "cli-test-config");
    const outDir = path.join(workDir, "out");
    await fs.mkdir(outDir, { recursive: true });

    // Create a symlink to the assets directory so the config can reference it
    const assetsLink = path.join(workDir, "images");
    try { await fs.symlink(ASSETS_DIR, assetsLink); } catch { /* may already exist */ }

    // Create a config file pointing to templates and the output dir
    const config = {
        root: TEMPLATES_DIR,
        output: [{ lang: "js", path: "out" }],
        assets: [{ name: "images", path: "images", prefix: "/img/" }],
    };
    await fs.writeFile(path.join(workDir, "backflip.json"), JSON.stringify(config));

    // Put an existing file in the output directory
    await fs.writeFile(path.join(outDir, "stale.txt"), "should be removed");

    try {
        const { code, stdout, stderr } = await runCli([], workDir);
        assertEquals(code, 0, `Expected exit 0, got ${code}. stderr: ${stderr}`);

        // The stale file should be gone
        let staleExists = true;
        try {
            await fs.access(path.join(outDir, "stale.txt"));
        } catch {
            staleExists = false;
        }
        assertEquals(staleExists, false, "Stale file should have been removed");

        // New files should have been generated
        assertEquals(stdout.includes("Generated"), true, `Expected 'Generated' in stdout: ${stdout}`);
    } finally {
        await fs.rm(workDir, { recursive: true, force: true });
    }
});

Deno.test("Config: compiles multiple outputs (js and php)", async () => {
    const workDir = path.join(TMPDIR, "cli-test-multi");
    const jsOut = path.join(workDir, "js-out");
    const phpOut = path.join(workDir, "php-out");
    await fs.mkdir(workDir, { recursive: true });

    const assetsLink = path.join(workDir, "images");
    try { await fs.symlink(ASSETS_DIR, assetsLink); } catch { /* may already exist */ }

    const config = {
        root: TEMPLATES_DIR,
        output: [
            { lang: "js", path: "js-out" },
            { lang: "php", path: "php-out" },
        ],
        assets: [{ name: "images", path: "images", prefix: "/img/" }],
    };
    await fs.writeFile(path.join(workDir, "backflip.json"), JSON.stringify(config));

    try {
        const { code, stdout, stderr } = await runCli([], workDir);
        assertEquals(code, 0, `Expected exit 0, got ${code}. stderr: ${stderr}`);

        // Both output dirs should exist and contain files
        const jsEntries = await fs.readdir(jsOut);
        const phpEntries = await fs.readdir(phpOut);
        assertEquals(jsEntries.length > 0, true, "js output dir should have files");
        assertEquals(phpEntries.length > 0, true, "php output dir should have files");

        assertEquals(stdout.includes("js"), true, `Expected 'js' in stdout: ${stdout}`);
        assertEquals(stdout.includes("php"), true, `Expected 'php' in stdout: ${stdout}`);
    } finally {
        await fs.rm(workDir, { recursive: true, force: true });
    }
});

Deno.test("Config: asset dir that doubles as dom-patch output dir does not report missing assets", async () => {
    // Mirrors the demo-attr-meter setup: the `bfdom` asset dir is the same dir the
    // build writes dom-patch JS to. A page referencing @bfdom/<file>.js must not be
    // flagged as a missing asset just because the build cleans+regenerates that dir.
    const workDir = path.join(TMPDIR, "cli-test-bfdom-asset");
    const templatesDir = path.join(workDir, "templates");
    const bfdomDir = path.join(workDir, "static-bfdom");
    await fs.mkdir(templatesDir, { recursive: true });
    await fs.mkdir(bfdomDir, { recursive: true });

    // A custom element with a dynamic attribute → produces dom-patch JS (widget.js).
    await fs.writeFile(
        path.join(templatesDir, "widget.html"),
        `<my-widget b-attr:level :class="level > 80 ? 'high' : ''" b-export>\n\t<meter :value="level"></meter>\n</my-widget>\n`,
    );
    // A page that references the generated dom-patch JS as a bfdom asset.
    await fs.writeFile(
        path.join(templatesDir, "page.html"),
        `<html b-name="page" b-export>\n\t<my-widget level="90"></my-widget>\n\t<script lang="js" src~="@bfdom/widget.js"></script>\n</html>\n`,
    );

    const config = {
        root: "templates",
        output: [
            { lang: "dom-patch", path: "static-bfdom" },
            { lang: "js", path: "compiled" },
        ],
        assets: [{ name: "bfdom", path: "static-bfdom", prefix: "/static-bfdom/" }],
    };
    await fs.writeFile(path.join(workDir, "backflip.json"), JSON.stringify(config));

    try {
        const { code, stdout, stderr } = await runCli([], workDir);
        assertEquals(
            stderr.includes("asset file not found"),
            false,
            `Should not report the generated dom-patch asset as missing. stderr: ${stderr}`,
        );
        assertEquals(code, 0, `Expected exit 0, got ${code}. stderr: ${stderr}`);
        assertEquals(stdout.includes("Generated"), true, `Expected 'Generated' in stdout: ${stdout}`);

        // The dom-patch JS the page referenced should actually exist after the build.
        await fs.stat(path.join(bfdomDir, "widget.js"));
    } finally {
        await fs.rm(workDir, { recursive: true, force: true });
    }
});

Deno.test("Config: reference to a dom-patch asset no template generates is still reported missing", async () => {
    // Guards against the over-broad fix: validating after generation must still
    // catch a bad @bfdom/<name>.js reference when no template produces that file.
    const workDir = path.join(TMPDIR, "cli-test-bfdom-missing");
    const templatesDir = path.join(workDir, "templates");
    await fs.mkdir(templatesDir, { recursive: true });
    await fs.mkdir(path.join(workDir, "static-bfdom"), { recursive: true });

    await fs.writeFile(
        path.join(templatesDir, "widget.html"),
        `<my-widget b-attr:level :class="level > 80 ? 'high' : ''" b-export>\n\t<meter :value="level"></meter>\n</my-widget>\n`,
    );
    // Page references @bfdom/typo.js — there is no typo.html, so nothing generates it.
    await fs.writeFile(
        path.join(templatesDir, "page.html"),
        `<html b-name="page" b-export>\n\t<my-widget level="90"></my-widget>\n\t<script lang="js" src~="@bfdom/typo.js"></script>\n</html>\n`,
    );

    const config = {
        root: "templates",
        output: [
            { lang: "dom-patch", path: "static-bfdom" },
            { lang: "js", path: "compiled" },
        ],
        assets: [{ name: "bfdom", path: "static-bfdom", prefix: "/static-bfdom/" }],
    };
    await fs.writeFile(path.join(workDir, "backflip.json"), JSON.stringify(config));

    try {
        const { code, stderr } = await runCli([], workDir);
        assertEquals(
            stderr.includes("asset file not found: @bfdom/typo.js"),
            true,
            `Expected missing-asset error for the typo'd reference. stderr: ${stderr}`,
        );
        assertEquals(code, 1, `Expected exit 1 for missing asset, got ${code}. stderr: ${stderr}`);
    } finally {
        await fs.rm(workDir, { recursive: true, force: true });
    }
});
