import { parseArgs } from '@std/cli/parse-args';
import { join, dirname } from 'node:path';
import { compileDirectory } from './compiler/partials.ts';
import { loadConfig, resolveConfigRoot, resolveAssetDirs, type OutputConfig } from './compiler/config.ts';
import { fileToJsModule } from './compiler/generate/js/nodes2js.ts';
import { fileToPhpFile } from './compiler/generate/php/nodes2php.ts';
import { resolveAssetRefs } from './compiler/compiler.ts';
import { discoverAssetFileInfos, collectAllAssetReferences, validateAssetFiles, buildAssetUsageReport, filterReport } from './assets/src/index.ts';

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
  { "root": "src/templates", "output": [{ "lang": "js", "path": "dist" }] }
  CLI arguments override config output entries.`;

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
const cliOutputDir = args._[1] as string | undefined;
const cliLang = args.lang as string | undefined;
let outputs: OutputConfig[] = [];
let outputsFromConfig = false;

// Load config as fallback for missing arguments
const { config, errors: configErrors } = await loadConfig(Deno.cwd());
let assetMap: Map<string, string> | undefined;
let assetDirs: Map<string, string> | undefined;
if (config) {
    if (!inputDir) inputDir = resolveConfigRoot(Deno.cwd(), config);
    if (config.assets && config.assets.length > 0) {
        assetMap = new Map(config.assets.map(a => [a.name, a.prefix]));
        assetDirs = resolveAssetDirs(Deno.cwd(), config);
    }
}
if (cliOutputDir || cliLang) {
    if (!cliOutputDir || !cliLang) {
        // partial CLI override — handled below in generate-mode validation
    } else if (cliLang !== 'js' && cliLang !== 'php') {
        printUsageAndExit('--lang <js|php> is required');
    } else {
        outputs = [{ lang: cliLang, path: cliOutputDir }];
    }
} else if (config?.output) {
    outputs = config.output.map(o => ({ lang: o.lang, path: join(Deno.cwd(), o.path) }));
    outputsFromConfig = true;
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

    const { directory, errors } = await compileDirectory(inputDir, assetMap || assetDirs ? { assetMap, assetDirs } : undefined);

    if (assetDirs) {
        const refs = collectAllAssetReferences(directory.files, assetDirs);
        const assetErrors = validateAssetFiles(refs, assetDirs);
        errors.push(...assetErrors);
    }

    if (args.json) {
        console.log(JSON.stringify({ errors: errors.map(e => e.message) }));
    } else {
        for (const err of errors) {
            if (err.severity === 'warning') console.warn(`warning: ${err.message}`);
            else console.error(err.message);
        }
    }

    const failingErrors = errors.filter(e => e.severity !== 'warning');
    Deno.exit(failingErrors.length > 0 ? 1 : 0);
} else if (args['assets-report']) {
    if (!assetDirs) {
        console.error('No asset directories configured in backflip.json');
        Deno.exit(1);
    }
    const compileOpts = assetMap || assetDirs ? { assetMap, assetDirs } : undefined;
    const { directory, errors } = await compileDirectory(inputDir, compileOpts);
    const fatalErrors = errors.filter(e => e.severity === 'fatal');
    if (fatalErrors.length > 0) {
        for (const err of fatalErrors) console.error(err.message);
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
    if (outputs.length === 0) {
        if (cliOutputDir && !cliLang) {
            printUsageAndExit('--lang <js|php> is required');
        }
        if (!cliOutputDir && cliLang) {
            printUsageAndExit('Missing <output-dir> argument');
        }
        printUsageAndExit('Missing output configuration (provide <output-dir> --lang or set "output" in backflip.json)');
    }

    for (const out of outputs) {
        let empty: boolean;
        try {
            empty = await isEmptyDir(out.path);
        } catch {
            empty = true;
        }
        if (!empty) {
            if (outputsFromConfig) {
                await Deno.remove(out.path, { recursive: true });
            } else {
                console.error(`Output directory is not empty: ${out.path}`);
                Deno.exit(1);
            }
        }
    }

    const compileOpts = assetMap || assetDirs ? { assetMap, assetDirs } : undefined;
    const { directory: result, errors } = await compileDirectory(inputDir, compileOpts);

    if (assetDirs) {
        const refs = collectAllAssetReferences(result.files, assetDirs);
        const assetErrors = validateAssetFiles(refs, assetDirs);
        errors.push(...assetErrors);
    }

    const fatalErrors = errors.filter(e => e.severity === 'fatal');
    const nonFatalErrors = errors.filter(e => e.severity === 'error');
    const warnings = errors.filter(e => e.severity === 'warning');

    if (fatalErrors.length > 0) {
        for (const err of fatalErrors) {
            console.error(err.message);
        }
        Deno.exit(1);
    }

    if (nonFatalErrors.length > 0) {
        for (const err of nonFatalErrors) {
            console.error(err.message);
        }
    }

    if (warnings.length > 0) {
        for (const warn of warnings) {
            console.warn(`warning: ${warn.message}`);
        }
    }

    for (const out of outputs) {
        let count = 0;
        for (const [relPath, compiledFile] of result.files) {
            const ext = out.lang === 'js' ? '.js' : '.php';
            const outRelPath = relPath.replace(/\.html$/, ext);
            const outPath = join(out.path, outRelPath);
            const resolved = assetMap ? resolveAssetRefs(compiledFile, assetMap) : compiledFile;
            const generated = out.lang === 'js'
                ? fileToJsModule(resolved, relPath, assetMap)
                : fileToPhpFile(resolved, relPath, assetMap);
            Deno.mkdirSync(dirname(outPath), { recursive: true });
            Deno.writeTextFileSync(outPath, generated);
            count++;
        }
        console.log(`Generated ${count} ${out.lang} file${count !== 1 ? 's' : ''} to ${out.path}`);
    }

    if (nonFatalErrors.length > 0) {
        Deno.exit(1);
    }
}
