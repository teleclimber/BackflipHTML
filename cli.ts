import { parseArgs } from '@std/cli/parse-args';
import { join, dirname } from 'node:path';
import { compileDirectory } from './compiler/partials.ts';
import { loadConfig, resolveConfigRoot, resolveAssetDirs } from './compiler/config.ts';
import { fileToJsModule } from './compiler/generate/js/nodes2js.ts';
import { fileToPhpFile } from './compiler/generate/php/nodes2php.ts';
import { resolveAssetRefs } from './compiler/compiler.ts';
import { discoverAssetFileInfos, collectAllAssetReferences, buildAssetUsageReport, filterReport } from './assets/src/index.ts';

const HELP = `Usage:
  backflip                                             Use backflip.json config
  backflip <input-dir> <output-dir> --lang <js|php>    Compile and generate files
  backflip <input-dir> --check [--json]                Check for errors
  backflip --check [--json]                            Check using backflip.json
  backflip --assets-report [--json] [--unused-only]    Report asset usage

Options:
  --lang <js|php>     Output language (required for generate mode unless in config)
  --check             Check for errors only, no output written
  --assets-report     Show asset usage report (exits 1 if unused assets found)
  --unused-only       Only show unused assets (use with --assets-report)
  --json              Output as JSON (use with --check or --assets-report)
  --help              Show this help message

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
    boolean: ['check', 'json', 'help', 'assets-report', 'unused-only'],
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
let outputDirFromConfig = false;

// Load config as fallback for missing arguments
const { config, errors: configErrors } = await loadConfig(Deno.cwd());
let assetMap: Map<string, string> | undefined;
let assetDirs: Map<string, string> | undefined;
if (config) {
    if (!inputDir) inputDir = resolveConfigRoot(Deno.cwd(), config);
    if (!outputDir && config.output) {
        outputDir = join(Deno.cwd(), config.output);
        outputDirFromConfig = true;
    }
    if (!lang && config.lang) lang = config.lang;
    if (config.assets && config.assets.length > 0) {
        assetMap = new Map(config.assets.map(a => [a.name, a.prefix]));
        assetDirs = resolveAssetDirs(Deno.cwd(), config);
    }
}
for (const err of configErrors) {
    console.error(err);
}

if (!inputDir) {
    printUsageAndExit('Missing <input-dir> argument (or create a backflip.json with "root")');
}

if (args.check) {
    if (args._.length >= 2 || args.lang) {
        printUsageAndExit('--check mode does not accept <output-dir> or --lang');
    }

    const { errors } = await compileDirectory(inputDir, assetMap || assetDirs ? { assetMap, assetDirs } : undefined);

    if (args.json) {
        console.log(JSON.stringify({ errors: errors.map(e => e.message) }));
    } else {
        for (const err of errors) {
            console.error(err.message);
        }
    }

    Deno.exit(errors.length > 0 ? 1 : 0);
} else if (args['assets-report']) {
    if (!assetDirs) {
        console.error('No asset directories configured in backflip.json');
        Deno.exit(1);
    }
    const compileOpts = assetMap || assetDirs ? { assetMap, assetDirs } : undefined;
    const { directory, errors } = await compileDirectory(inputDir, compileOpts);
    if (errors.length > 0) {
        for (const err of errors) console.error(err.message);
        Deno.exit(1);
    }

    const assets = discoverAssetFileInfos(assetDirs);
    const refs = collectAllAssetReferences(directory.files, assetDirs);
    let report = buildAssetUsageReport(assets, refs);
    if (args['unused-only']) {
        report = filterReport(report, { unusedOnly: true });
    }

    if (args.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        console.log(`Assets: ${report.summary.totalAssets} total, ${report.summary.usedAssets} used, ${report.summary.unusedAssets} unused`);
        console.log(`References: ${report.summary.totalReferences} total`);
        if (report.entries.length > 0) {
            console.log('');
            for (const entry of report.entries) {
                const status = entry.isUsed ? '  used' : 'UNUSED';
                console.log(`  [${status}] @${entry.asset.name}/${entry.asset.subpath}`);
                for (const ref of entry.references) {
                    const loc = ref.partialName ? ` (${ref.partialName}:${ref.line})` : ` (:${ref.line})`;
                    console.log(`           <- ${ref.sourceFile}${loc}`);
                }
            }
        }
    }

    Deno.exit(report.summary.unusedAssets > 0 ? 1 : 0);
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
        if (outputDirFromConfig) {
            // When output dir comes from config, auto-clean it
            await Deno.remove(outputDir, { recursive: true });
        } else {
            console.error(`Output directory is not empty: ${outputDir}`);
            Deno.exit(1);
        }
    }

    const compileOpts = assetMap || assetDirs ? { assetMap, assetDirs } : undefined;
    const { directory: result, errors } = await compileDirectory(inputDir, compileOpts);

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
        const resolved = assetMap ? resolveAssetRefs(compiledFile, assetMap) : compiledFile;
        const generated = lang === 'js'
            ? fileToJsModule(resolved, relPath, assetMap)
            : fileToPhpFile(resolved, relPath, assetMap);
        Deno.mkdirSync(dirname(outPath), { recursive: true });
        Deno.writeTextFileSync(outPath, generated);
        count++;
    }

    console.log(`Generated ${count} file${count !== 1 ? 's' : ''} to ${outputDir}`);
}
