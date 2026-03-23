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

    // Create a config file pointing to templates and the output dir
    const config = {
        root: TEMPLATES_DIR,
        output: "out",
        lang: "js",
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
