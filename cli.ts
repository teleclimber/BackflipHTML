import { parseArgs } from '@std/cli/parse-args';
import { join, dirname } from 'node:path';
import { compileDirectory } from './compiler/partials.ts';
import { loadConfig, resolveConfigRoot } from './compiler/config.ts';
import { fileToJsModule } from './compiler/generate/js/nodes2js.ts';
import { fileToPhpFile } from './compiler/generate/php/nodes2php.ts';

const HELP = `Usage:
  backflip                                             Use backflip.json config
  backflip <input-dir> <output-dir> --lang <js|php>    Compile and generate files
  backflip <input-dir> --check [--json]                Check for errors
  backflip --check [--json]                            Check using backflip.json

Options:
  --lang <js|php>   Output language (required for generate mode unless in config)
  --check           Check for errors only, no output written
  --json            Output errors as JSON (use with --check)
  --help            Show this help message

Config (backflip.json):
  { "root": "src/templates", "output": "dist", "lang": "js" }
  CLI arguments override config values.`;

function printUsageAndExit(msg?: string): never {
    if (msg) console.error(msg);
    console.error(HELP);
    Deno.exit(1);
}

async function isEmptyDir(dir: string): Promise<boolean> {
    for await (const _ of Deno.readDir(dir)) {
        return false;
    }
    return true;
}

const args = parseArgs(Deno.args, {
    boolean: ['check', 'json', 'help'],
    string: ['lang'],
    unknown: (arg, key) => { if (key !== undefined) printUsageAndExit(`Unknown flag: ${arg}`); },
});

if (args.help) {
    console.log(HELP);
    Deno.exit(0);
}

let inputDir = args._[0] as string | undefined;
let outputDir = args._[1] as string | undefined;
let lang = args.lang as string | undefined;

// Load config as fallback for missing arguments
const config = await loadConfig(Deno.cwd());
if (config) {
    if (!inputDir) inputDir = resolveConfigRoot(Deno.cwd(), config);
    if (!outputDir && config.output) outputDir = join(Deno.cwd(), config.output);
    if (!lang && config.lang) lang = config.lang;
}

if (!inputDir) {
    printUsageAndExit('Missing <input-dir> argument (or create a backflip.json with "root")');
}

if (args.check) {
    if (args._.length >= 2 || args.lang) {
        printUsageAndExit('--check mode does not accept <output-dir> or --lang');
    }

    const { errors } = await compileDirectory(inputDir);

    if (args.json) {
        console.log(JSON.stringify({ errors: errors.map(e => e.message) }));
    } else {
        for (const err of errors) {
            console.error(err.message);
        }
    }

    Deno.exit(errors.length > 0 ? 1 : 0);
} else {
    if (!outputDir) {
        printUsageAndExit('Missing <output-dir> argument (or set "output" in backflip.json)');
    }
    if (!lang || (lang !== 'js' && lang !== 'php')) {
        printUsageAndExit('--lang <js|php> is required (or set "lang" in backflip.json)');
    }

    let empty: boolean;
    try {
        empty = await isEmptyDir(outputDir);
    } catch {
        // Directory doesn't exist — that's fine, we'll create it
        empty = true;
    }

    if (!empty) {
        console.error(`Output directory is not empty: ${outputDir}`);
        Deno.exit(1);
    }

    const { directory: result, errors } = await compileDirectory(inputDir);

    if (errors.length > 0) {
        for (const err of errors) {
            console.error(err.message);
        }
        Deno.exit(1);
    }

    let count = 0;
    for (const [relPath, compiledFile] of result.files) {
        const ext = lang === 'js' ? '.js' : '.php';
        const outRelPath = relPath.replace(/\.html$/, ext);
        const outPath = join(outputDir, outRelPath);
        const generated = lang === 'js'
            ? fileToJsModule(compiledFile, relPath)
            : fileToPhpFile(compiledFile, relPath);
        Deno.mkdirSync(dirname(outPath), { recursive: true });
        Deno.writeTextFileSync(outPath, generated);
        count++;
    }

    console.log(`Generated ${count} file${count !== 1 ? 's' : ''} to ${outputDir}`);
}
